/**
 * pi-subagents — AgentProcess.
 *
 * One resident `pi --mode rpc` child, wrapped behind Agent-tool semantics.
 * The parent extension holds N AgentProcess instances (foreground: one at a
 * time; background: several).
 *
 * Lifecycle:
 *   spawnAndSend(prompt) → running
 *   [ optional: steer(msg) / abort() while running ]
 *   waitForCompletion()  → terminal (completed / failed / stopped)
 *   stop()               → graceful stdin EOF, SIGTERM fallback
 *
 * Token limits: none. A timeoutMs (if set) bounds every turn — the first one
 *   and each wake of a resident agent: on expiry, abort → graceful settle
 *   within the grace window → hard-stop if it never settles. Otherwise the
 *   child runs until it finishes or is stopped via agent_stop.
 */

import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { AssistantStream, type AssistantStreamSnapshot } from "./assistant-stream.js";
import type { AgentTreeEvent } from "./event-interpret.js";
import { type AgentActivity, interpretEvent } from "./event-interpret.js";
import type { AgentMessage, RpcCommand, RpcEvent, RpcResponse } from "./protocol.js";
import { RpcClient, type RpcClientOptions } from "./rpc-client.js";
import type { RenderEvent } from "./types.js";

type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

type TerminalStatus = Exclude<AgentStatus, "queued" | "running">;

/** How a woken turn of a resident agent ended. */
export type WakeOutcome = "completed" | "failed" | "stopped";

/** The slice of rpc get_state the agent view's footer reads. */
export interface ChildState {
	model?: Model<Api>;
	thinkingLevel?: string;
	autoCompactionEnabled?: boolean;
}

interface AgentStats {
	tokens: number;
	toolUses: number;
	durationMs: number;
}

export interface AgentCompletion {
	/** Stable identity of one process settlement, not its output text. */
	completionId: string;
	status: TerminalStatus;
	output: string;
	stats: AgentStats;
	sessionPath?: string;
	sessionId?: string;
	/** The parent was waiting for this turn's answer (see AgentProcess.parentIsWaiting). */
	owedToParent?: boolean;
	/** Control-stop policy frozen for this turn, not a later wake of the process. */
	stoppedByControl?: boolean;
}

export interface AgentProcessOptions {
	cwd: string;
	/** Resolved "provider/id" model string, or inherit when omitted. */
	model?: string;
	/** Reasoning intensity ("off"…"max"), passed as --thinking. */
	thinking?: string;
	/** Tool allowlist (comma-joined into --tools; agent_send is always added). */
	tools?: string[];
	/** Additional extension paths (--extension per distinct path), including on revival. */
	extensions?: string[];
	/** Short task label (notification card). */
	label: string;
	/** Short human-readable id ("max", "zoe") assigned by the registry (name-gen.ts). */
	agentId: string;
	/** Custom session storage dir (--session-dir) — keeps sub-agent sessions out of `pi -r`. */
	sessionDir?: string;
	/** Wall-clock limit for each turn: the first one, and every wake of a
	 *  resident agent. Omitted = no limit (the default): the child runs until
	 *  it finishes or is stopped — there is no token limit (SPEC: no token limit). */
	timeoutMs?: number;
	/** After an abort, how long to wait for the child to settle before hard-stopping it. */
	abortSettleGraceMs?: number;
	/** Streamed assistant text deltas (rpc message_update/text_delta) — for live tool-card output. */
	onDelta?: (delta: string) => void;
	/** Thinking/tool activity transitions (no text delta involved) — for live tool-card rows. */
	onActivityChange?: (activity: AgentActivity) => void;
	/** In-tree message received from this child (extension_ui_request under the reserved key). */
	onMessage?: (message: AgentMessage) => void;
	/** Tree telemetry from this child's own spawns (extension_ui_request, tree key) — forward or apply. */
	onTreeEvent?: (event: AgentTreeEvent) => void;
	/** A resident starts a fresh turn, whether from a prompt or an internal trigger. */
	onWake?: () => void;
	/** A woken persistent agent's turn ended: "completed" → idle; "failed"
	 *  (model error or crash) and "stopped" (timeoutMs) → report + clean up. */
	onIdle?: (outcome: WakeOutcome) => void;
	/** Resident after completion (idle, zero token) — explicit opt-in, default off. */
	persistent?: boolean;
	/** Extra child environment (identity injection: PI_SUBAGENT_AGENT_ID / PI_SUBAGENT_PARENT). */
	env?: NodeJS.ProcessEnv;
	/** Continue an existing session file (revive) instead of starting a new session. */
	resumeSession?: string;
	/** The child process exited (any reason). */
	onExit?: () => void;
}

interface AgentProcessDeps {
	/** Test seam: override client creation (defaults to a real RpcClient). */
	createClient?: (options: RpcClientOptions) => RpcClient;
}

const DEFAULT_ABORT_SETTLE_GRACE_MS = 30_000;
const STOP_GRACE_MS = 5_000;

// The only task-level limit is the opt-in timeoutMs: the Agent tool passes
// it when the caller wants a bound — the default is no limit (a Pi extension
// should not impose hidden deadlines on sub-agents).

export class AgentProcess {
	readonly agentId: string;
	readonly label: string;
	readonly startedAt = Date.now();
	readonly model: string | undefined;
	readonly thinking: string | undefined;
	/** Resident after completion (idle, zero token) — explicit opt-in. */
	readonly persistent: boolean;

	status: AgentStatus = "queued";

	/** True when stop() was called via agent_stop (deliberate user action → no notification). */
	stoppedByControl = false;
	/** The user stopped it from the agent view (not the parent's agent_stop). */
	stoppedByUser = false;

	/** When the current turn started: the spawn, or the wake that resumed it. */
	turnStartedAt = this.startedAt;

	private readonly client: RpcClient;
	private readonly timeoutMs: number | undefined;
	private readonly abortSettleGraceMs: number;

	private settleWaiters = new Set<() => void>();
	/** Total agent_settled events seen; lets awaitSettled skip settles that
	 *  arrived while no waiter was attached (synchronous test emit pattern). */
	private settleCount = 0;
	private readonly processId = randomUUID();

	private readonly initialTurn: { sequence: number; completion?: Promise<AgentCompletion>; output?: string } = {
		sequence: 1,
	};
	private turn = this.initialTurn;
	private stopPromise: Promise<void> | undefined;
	private streaming: AssistantStream | undefined;
	private sessionInfoReady: Promise<void> = Promise.resolve();

	/** Turn identity changes on acceptance, not only when the next turn settles. */
	get completionId(): string {
		return `${this.processId}:${this.turn.sequence}`;
	}

	isCurrentCompletion(completion: AgentCompletion): boolean {
		return completion.completionId === this.completionId;
	}

	/** The immutable settlement captured before an onIdle callback or waiter runs. */
	completionSnapshot(): Promise<AgentCompletion> {
		if (!this.turn.completion) return Promise.reject(new Error("Agent turn has not settled"));
		return this.turn.completion;
	}
	/** settleCount observed at the last awaitSettled() call. */
	private lastSettledCount = 0;
	private done = false;
	private hardAborted = false;
	/** Model API error captured from agent_end (stopReason "error"). */
	private agentError: string | null = null;
	/** Latest activity excerpt for the widget. */
	private latestActivity: AgentActivity | null = null;
	/** Ordered activity stream — accumulated from RPC events at the source. */
	private events: RenderEvent[] = [];

	sessionPath?: string;
	sessionId?: string;

	/** The parent is waiting for the current turn's answer: it started the
	 *  turn (spawn, agent_send) or messaged during it. A user side-chat message
	 *  in the same turn never cancels that; a turn only the user started (a
	 *  side chat from the agent view) is not reported up. Internal wakes (for
	 *  example a background-bash result) inherit the preceding turn's owner. */
	private parentWaiting = false;
	/** Pending wake-turn limit: the timeoutMs clock, then the abort grace. */
	private wakeTimer: NodeJS.Timeout | undefined;
	private wakeTimedOut = false;

	/** The child's own extension statuses (its footer line), by key. */
	private readonly statuses = new Map<string, string>();

	/** Raw rpc event listeners (the agent view renders the live transcript). */
	private readonly listeners = new Set<(event: RpcEvent) => void>();

	constructor(options: AgentProcessOptions, deps: AgentProcessDeps = {}) {
		this.agentId = options.agentId;
		this.label = options.label;
		this.timeoutMs = options.timeoutMs;
		this.abortSettleGraceMs = options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS;
		this.model = options.model;
		this.thinking = options.thinking;
		this.persistent = options.persistent ?? false;
		this.onDelta = options.onDelta;
		this.onActivityChange = options.onActivityChange;
		this.onMessage = options.onMessage;
		this.onTreeEvent = options.onTreeEvent;
		this.onWake = options.onWake;
		this.onIdle = options.onIdle;

		const args: string[] = [];
		if (options.model) args.push("--model", options.model);
		if (options.thinking) args.push("--thinking", options.thinking);
		// agent_send is the child's channel to @parent: an allowlist never removes it.
		if (options.tools !== undefined) args.push("--tools", [...new Set([...options.tools, "agent_send"])].join(","));
		for (const extension of new Set(options.extensions)) args.push("--extension", extension);
		if (options.resumeSession) {
			// Revive: the session file already carries its name, model and thinking.
			args.push("--session", options.resumeSession);
			this.sessionPath = options.resumeSession;
		} else {
			// Label names the session (--name, capped at 80 chars).
			args.push("--name", options.label.slice(0, 80));
			if (options.sessionDir) args.push("--session-dir", options.sessionDir);
		}

		const clientOptions: RpcClientOptions = {
			args,
			cwd: options.cwd,
			env: options.env,
			onEvent: (event) => {
				this.onEvent(event);
				for (const listener of this.listeners) listener(event);
			},
			onExit: () => {
				this.clearWakeClock();
				// An exit without settlement is a crash, including signal exits
				// whose numeric exitCode is null (and premature code-zero exits).
				if (!this.turn.completion && this.status !== "stopped") {
					if (this.done && this.persistent && this.status === "running") this.finishWake("failed");
					else {
						this.status = "failed";
						this.captureCompletion("failed");
					}
				}
				this.settle();
				this.done = true;
				options.onExit?.();
			},
		};
		this.client = deps.createClient ? deps.createClient(clientOptions) : new RpcClient(clientOptions);
	}

	// ── Public API ─────────────────────────────────────────

	/** Spawn + send the prompt; resolves once the prompt preflight succeeded.
	 *  `origin` "user" is a side chat from the agent view (a revive): its
	 *  answer stays in the agent's session. */
	async spawnAndSend(
		prompt: string,
		origin: "parent" | "user" = "parent",
	): Promise<{ ok: true } | { ok: false; error: string }> {
		let accepted = false;
		const accept = (response: RpcResponse) => {
			if (accepted || !response.success || this.isHandled(response)) return;
			accepted = true;
			this.parentWaiting = origin === "parent";
			if (!this.turn.completion && this.status !== "stopped") this.status = "running";
			this.sessionInfoReady = this.sendData<{ sessionFile?: string; sessionId?: string }>({ type: "get_state" }).then(
				(data) => {
					if (data) {
						this.sessionPath = data.sessionFile ?? this.sessionPath;
						this.sessionId = data.sessionId;
					}
				},
			);
		};
		const response = await this.client.sendCommand({ type: "prompt", message: prompt }, accept).catch((err: Error) => ({
			type: "response" as const,
			command: "prompt",
			success: false as const,
			error: err.message,
		}));

		if (!response.success || this.isHandled(response)) {
			if (this.status !== "stopped") this.status = "failed";
			return {
				ok: false,
				error: response.success ? "Prompt was handled without starting an agent turn" : response.error,
			};
		}
		// Structural test clients may not implement the synchronous response hook.
		accept(response);

		// An instant settlement can precede this read; its snapshot also waits
		// for the same best-effort session metadata, not another mutable query.
		await this.sessionInfoReady;

		return { ok: true };
	}

	/** Hard-interrupt the current turn. */
	async abort(): Promise<void> {
		await this.client.sendCommand({ type: "abort" }).catch(() => {});
	}

	/**
	 * Deliver one in-tree message to this agent (parent→child): a prompt
	 * with streamingBehavior "steer" — idle starts a new turn (wake), a
	 * running child queues it (delivered after the turn). Resolves whether
	 * the prompt preflight accepted the message. Waking an idle persistent
	 * agent flips it back to running and starts a new turn.
	 */
	async sendMessage(text: string, origin: "parent" | "user" = "parent"): Promise<boolean> {
		if (this.status === "failed" || this.status === "stopped" || this.client.isClosed) return false;
		// An idle user interaction is a privacy boundary, even if an extension
		// handles the prompt and triggers its model run before or after the RPC
		// response. agent_start has no source ID, so later autonomous work stays
		// private until an accepted parent prompt explicitly claims it again.
		// A completed snapshot already froze its owner; active parent work is
		// unaffected by user side-chat input.
		if (origin === "user" && this.status === "completed") this.parentWaiting = false;
		let accepted = false;
		const accept = (response: RpcResponse) => {
			if (accepted || !response.success || this.isHandled(response)) return;
			accepted = true;
			if (this.status === "completed") {
				this.startWake(origin === "parent");
			} else if (origin === "parent") {
				this.parentWaiting = true;
			}
		};
		const response = await this.client
			.sendCommand({ type: "prompt", message: text, streamingBehavior: "steer" }, accept)
			.catch((err: Error) => ({
				type: "response" as const,
				command: "prompt" as const,
				success: false as const,
				error: err.message,
			}));
		if (!response.success || this.isHandled(response)) return false;
		accept(response);
		return true;
	}

	private isHandled(response: RpcResponse): boolean {
		return response.success && (response.data as { disposition?: string } | undefined)?.disposition === "handled";
	}

	/** Whether the parent is waiting for the current (or just-settled) turn's answer. */
	get parentIsWaiting(): boolean {
		return this.parentWaiting;
	}

	/** Why the last turn failed: the model error, else the child's stderr. */
	get errorText(): string {
		return this.agentError ?? this.client.stderrText.trim();
	}

	/** Subscribe to the child's raw rpc events. Returns the unsubscribe function. */
	subscribe(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The child's current conversation (rpc get_messages); null when unavailable. */
	async getMessages(): Promise<unknown[] | null> {
		const data = await this.sendData<{ messages?: unknown[] }>({ type: "get_messages" });
		return data?.messages ?? null;
	}

	/** Independent live assistant snapshot for a view opened mid-stream. */
	getStreamingSnapshot(): AssistantStreamSnapshot | undefined {
		return this.streaming?.snapshot();
	}

	/** Whether the child process is still up (running or resident idle). */
	get isAlive(): boolean {
		return !this.client.isClosed;
	}

	/** The child's extension statuses, as its own footer would show them. */
	getStatuses(): ReadonlyMap<string, string> {
		return this.statuses;
	}

	/** The child's session state (rpc get_state): model, thinking level, compaction. */
	async getState(): Promise<ChildState | null> {
		return this.sendData<ChildState>({ type: "get_state" });
	}

	/** The child's context-window usage (rpc get_session_stats). */
	async getContextUsage(): Promise<ContextUsage | undefined> {
		const data = await this.sendData<{ contextUsage?: ContextUsage }>({ type: "get_session_stats" });
		return data?.contextUsage;
	}

	/** Current final assistant text (rpc get_last_assistant_text). */
	async lastOutput(): Promise<string> {
		const data = await this.sendData<{ text?: string | null }>({ type: "get_last_assistant_text" });
		return data?.text ?? "";
	}

	/** Best-effort token/tool stats from get_session_stats. */
	async getStats(): Promise<{ tokens: number; toolUses: number } | null> {
		const data = await this.sendData<{ tokens?: { total?: number }; toolCalls?: number }>({
			type: "get_session_stats",
		});
		if (!data) return null;
		return {
			tokens: data.tokens?.total ?? 0,
			toolUses: data.toolCalls ?? 0,
		};
	}

	/** sendCommand → typed response payload (null on failure/timeout/empty). */
	private async sendData<T>(command: RpcCommand): Promise<T | null> {
		const response = await this.client.sendCommand(command).catch(() => null);
		if (!response?.success || !response.data) return null;
		return response.data as T;
	}

	/**
	 * Wait for the spawn's initial turn, even if a resident already woke.
	 * Follow-up settlements are read through completionSnapshot().
	 *
	 * The wait is bounded by the overall deadline: a child stuck in a hung
	 * model call would otherwise make us wait forever (issue #10:
	 * a sub-agent completed but never settled; only a user interrupt
	 * released the wait). On deadline we abort, give the child a grace window
	 * to settle, then hard-stop it.
	 */
	async waitForCompletion(): Promise<AgentCompletion> {
		// Bind before spawn/preflight: a fast initial settlement can be followed
		// by a view wake while spawnAndSend still awaits session metadata.
		const turn = this.initialTurn;
		if (!turn.completion && this.status === "running") {
			const settled = await this.awaitSettled(this.timeoutMs);
			if (!turn.completion && !settled && turn === this.turn) {
				this.hardAborted = true;
				await this.abortAndWait();
			}
		}
		if (!turn.completion) {
			if (turn !== this.turn) throw new Error("Agent turn changed without settling");
			const status = this.terminalStatus();
			this.captureCompletion(status);
			this.status = status;
			this.done = true;
		}
		if (!turn.completion) throw new Error("Agent settlement snapshot was not captured");
		return turn.completion;
	}

	/**
	 * Graceful stop: stdin EOF → pi rpc shutdown(). If the child doesn't
	 * exit within STOP_GRACE_MS, SIGTERM as a fallback. Flags the stop as
	 * user-controlled (agent_stop / cancel) — suppresses notifications.
	 */
	async stop(): Promise<void> {
		this.clearWakeClock();
		// Closing an already idle resident does not retract its completed turn.
		if (!this.done || this.status === "running") this.stoppedByControl = true;
		await this.hardStop();
	}

	/** stdin EOF + SIGTERM fallback; waits for the child to exit. */
	private hardStop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		if (!this.turn.completion) this.captureCompletion("stopped");
		this.status = "stopped";
		this.done = true;
		this.client.endInput();
		this.settle();
		this.stopPromise = (async () => {
			if (await this.waitForExitWithin(STOP_GRACE_MS)) return;
			this.client.kill("SIGTERM");
			if (await this.waitForExitWithin(STOP_GRACE_MS)) return;
			this.client.kill("SIGKILL");
			await this.client.waitForExit();
		})();
		return this.stopPromise;
	}

	private async waitForExitWithin(ms: number): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				this.client.waitForExit().then(() => true),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), ms);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	/** Latest activity excerpt for the widget (undefined until the first message_update). */
	getLatestActivity(): AgentActivity | undefined {
		return this.latestActivity ?? undefined;
	}

	/**
	 * Ordered activity stream accumulated from every RPC event this agent
	 * processed. Thinking and tool-call activity are recorded as they arrive;
	 * text_delta events are folded into the current text event (consecutive
	 * deltas append). The stream mirrors pi's session replay order.
	 */
	getEvents(): RenderEvent[] {
		return this.events;
	}

	// ── Internal ───────────────────────────────────────────

	private readonly onDelta: ((delta: string) => void) | undefined;
	private readonly onActivityChange: ((activity: AgentActivity) => void) | undefined;
	private readonly onMessage: ((message: AgentMessage) => void) | undefined;
	private readonly onTreeEvent: ((event: AgentTreeEvent) => void) | undefined;
	private readonly onWake: (() => void) | undefined;
	private readonly onIdle: ((outcome: WakeOutcome) => void) | undefined;

	private terminalStatus(): TerminalStatus {
		if (this.status === "stopped" || this.hardAborted || this.wakeTimedOut) return "stopped";
		if (this.agentError || this.status === "failed") return "failed";
		return "completed";
	}

	private captureCompletion(status: TerminalStatus): Promise<AgentCompletion> {
		const turn = this.turn;
		if (turn.completion) return turn.completion;
		const completionId = this.completionId;
		const owedToParent = this.parentWaiting;
		const stoppedByControl = this.stoppedByControl;
		const durationMs = Date.now() - this.turnStartedAt;
		const error =
			this.agentError ||
			this.client.stderrText.trim() ||
			(this.client.exitSignal
				? `pi exited (${this.client.exitSignal})`
				: this.client.isClosed
					? `pi exited before settling (code ${this.client.exitCode})`
					: "");
		const finalText = turn.output;
		// Queue BOTH reads now, before publishing idle or invoking a callback.
		// Later prompt writes cannot overtake these synchronous RPC requests.
		const outputRead = finalText === undefined ? this.lastOutput() : Promise.resolve(finalText);
		const statsRead = this.getStats();
		turn.completion = Promise.all([outputRead, statsRead, this.sessionInfoReady]).then(([output, stats]) => ({
			completionId,
			status,
			output: status === "failed" && !output.trim() ? error : output,
			stats: { tokens: stats?.tokens ?? 0, toolUses: stats?.toolUses ?? 0, durationMs },
			sessionPath: this.sessionPath,
			sessionId: this.sessionId,
			owedToParent,
			stoppedByControl,
		}));
		return turn.completion;
	}

	private onEvent(event: RpcEvent): void {
		if (event.type === "message_start" && (event.message as { role?: string } | undefined)?.role === "assistant") {
			this.streaming = new AssistantStream(event.message as AssistantMessage);
		} else if (event.type === "message_update") {
			this.streaming?.apply(event.assistantMessageEvent);
		}
		if (event.type === "message_end") {
			const message = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				this.streaming = undefined;
				this.turn.output = message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("");
			}
		}
		// Raw protocol shapes are interpreted in event-interpret.ts — the only
		// place pi's event vocabulary is mapped onto ours. Since v0.84.0 the
		// wire carries only assistantMessageEvent deltas, so each event maps to
		// a discrete marker here: the policy surface is settle bookkeeping,
		// thinking/tool activity push, streamed text folding, and in-tree
		// message delivery.
		for (const ev of interpretEvent(event)) {
			switch (ev.type) {
				case "started":
					// Extensions can resume an idle resident without a parent RPC
					// prompt (e.g. background-bash's triggerTurn). Give that run a
					// fresh settlement and inherit ownership. agent_start also fires
					// during retries: an already-running turn must not be split.
					if (this.persistent && this.status === "completed" && !this.client.isClosed) {
						this.startWake(this.parentWaiting);
					}
					break;
				case "settled": {
					const wake = this.done && this.persistent && this.status === "running";
					const status = this.terminalStatus();
					this.captureCompletion(status);
					this.status = status;
					this.done = true;
					this.clearWakeClock();
					this.settle();
					if (wake) this.finishWake(status);
					break;
				}
				case "thinking":
					// Collapse consecutive thinking deltas into one marker.
					if (this.events[this.events.length - 1]?.kind !== "thinking") {
						this.events.push({ kind: "thinking" });
						const activity: AgentActivity = { kind: "thinking", text: "" };
						this.latestActivity = activity;
						this.onActivityChange?.(activity);
					}
					break;
				case "tool_call": {
					// toolcall_end is the authoritative tool call: the wire streams
					// the name on toolcall_start and the arguments on toolcall_delta,
					// but only the end event carries the complete call, so the earlier
					// events are deliberately ignored. The row stays visible while the
					// tool actually executes, mirroring the pre-v0.84 card.
					this.events.push(ev.activity);
					this.latestActivity = ev.activity;
					this.onActivityChange?.(ev.activity);
					break;
				}
				case "text_delta": {
					// Fold consecutive text deltas into the current text event.
					const last = this.events[this.events.length - 1];
					if (last?.kind === "text") {
						last.text += ev.delta;
					} else {
						this.events.push({ kind: "text", text: ev.delta });
					}
					// Widget excerpt reflects the latest streamed text.
					this.latestActivity = { kind: "text", text: last?.kind === "text" ? last.text : ev.delta };
					this.onDelta?.(ev.delta);
					break;
				}
				case "agent_failed":
					this.agentError = ev.error;
					break;
				case "agent_msg":
					this.onMessage?.(ev.message);
					break;
				case "agent_tree":
					this.onTreeEvent?.(ev.event);
					break;
				case "status":
					if (ev.text === undefined) this.statuses.delete(ev.key);
					else this.statuses.set(ev.key, ev.text);
					break;
			}
		}
	}

	private finishWake(outcome: WakeOutcome): void {
		this.captureCompletion(outcome);
		this.status = outcome;
		this.onIdle?.(outcome);
	}

	private startWake(owedToParent: boolean): void {
		this.turn = { sequence: this.turn.sequence + 1 };
		this.agentError = null;
		this.status = "running";
		this.parentWaiting = owedToParent;
		this.startWakeClock();
		this.onWake?.();
	}

	/** A wake starts a new turn: restart the turn clock and its timeoutMs limit. */
	private startWakeClock(): void {
		this.clearWakeClock();
		this.lastSettledCount = this.settleCount;
		this.turnStartedAt = Date.now();
		this.wakeTimedOut = false;
		if (this.timeoutMs !== undefined) this.wakeTimer = setTimeout(() => void this.expireWake(), this.timeoutMs);
	}

	private clearWakeClock(): void {
		if (this.wakeTimer) clearTimeout(this.wakeTimer);
		this.wakeTimer = undefined;
	}

	/**
	 * A woken turn hit timeoutMs — the same escalation as the first turn:
	 * abort, and hard-stop if no settle arrives within the grace window. The
	 * settle (or the hard stop) reports the turn as stopped through onIdle.
	 */
	private async expireWake(): Promise<void> {
		this.wakeTimer = undefined;
		if (this.status !== "running") return;
		this.wakeTimedOut = true;
		await this.abort();
		if (this.status !== "running") return; // settled during the abort
		this.wakeTimer = setTimeout(() => {
			this.wakeTimer = undefined;
			if (this.status !== "running") return;
			// Not a user-controlled stop: the turn is reported as stopped.
			this.finishWake("stopped");
			void this.hardStop();
		}, this.abortSettleGraceMs);
	}

	private settle(): void {
		// Count-based: agent_settled fires when the child's run loop finishes —
		// a steer re-runs the loop and settles again, so each post-steer/
		// post-abort turn must be awaited (no one-shot latch). The count also
		// survives settles that arrive while no waiter is attached.
		this.settleCount++;
		for (const waiter of this.settleWaiters) waiter();
		this.settleWaiters.clear();
	}

	/**
	 * Resolve true on the next settle, or false after timeoutMs (no timeout
	 * when omitted). The waiter is removed from the set on either path so a
	 * late settle can't double-resolve.
	 */
	private awaitSettled(timeoutMs?: number): Promise<boolean> {
		if (this.turn.completion) return Promise.resolve(true);
		// A settle arrived since our last wait — pass through immediately.
		if (this.settleCount > this.lastSettledCount) {
			this.lastSettledCount = this.settleCount;
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const onSettle = () => {
				if (timer) clearTimeout(timer);
				this.settleWaiters.delete(onSettle);
				this.lastSettledCount = this.settleCount;
				resolve(true);
			};
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					this.settleWaiters.delete(onSettle);
					resolve(false);
				}, timeoutMs);
			}
			this.settleWaiters.add(onSettle);
		});
	}

	/**
	 * Abort the child and wait (bounded) for its settle. An abort can be
	 * ineffective when the child is stuck — hung model call, wedged run loop:
	 * if no settle arrives within the grace window, hard-stop the child (stdin
	 * EOF + SIGTERM fallback) so waitForCompletion can never hang forever.
	 */
	private async abortAndWait(): Promise<void> {
		await this.abort().catch(() => {});
		const settled = await this.awaitSettled(this.abortSettleGraceMs);
		if (!settled && !this.done && this.client.exitCode === null) {
			// Timeout/limit escalation, NOT a user-controlled stop — hard-stop
			// without flagging stoppedByControl so background notifications still fire.
			await this.hardStop();
		}
	}
}
