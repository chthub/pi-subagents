/**
 * pi-subagents — spawn isolated sub‑agent pi instances + in-tree messaging.
 *
 * Architecture:
 *   index.ts          — tool registration (agent_spawn / agent_stop / agent_send) + routing glue
 *   protocol.ts       — pure JSONL protocol layer + in-tree routing (tested)
 *   rpc-client.ts     — stateful thin JSONL client (spawn + transport)
 *   event-interpret.ts— raw RpcEvent → AgentEvent adapter (pure, tested)
 *   agent-process.ts  — AgentProcess: one resident `pi --mode rpc` child, semantic API
 *   registry.ts       — AgentRegistry: lifecycle + completion policy + routing (tested)
 *   model.ts          — model-spec → ResolvedModel (testable)
 *   name-gen.ts       — short human-readable agent ids (tested)
 *   spawn-session.ts  — spawn lifecycle (fg/bg/persistent) + outcome classification (tested)
 *   nested-fold.ts    — foreground-card nested-subtree meta counters (tested)
 *   tree-display.ts   — subtree display anchor: fold / forward / widget (single-display rule)
 *   notification.ts   — completion-notification payloads
 *   completion-inbox.ts — boundary-batched delivery, one wake for ready results
 *   types.ts          — shared tool-output / notification shapes
 *   views.ts          — tool card views (single source for the three cards)
 *   render.ts         — notification card renderer + custom-message shell
 *   widget.ts         — bottom agent list (one clickable line per agent)
 *   roster.ts         — the conversation's agents, live and finished (rebuilt on resume)
 *   agent-view.ts     — full-screen view of one agent: transcript + side-chat editor
 *   agent-footer.ts   — that view's footer: pi's FooterComponent fed the child's data
 *   transcript.ts     — child conversation rendered with pi's own components
 *
 * Every sub‑agent is a resident `pi --mode rpc` child with a persisted
 * session. Foreground agent_spawn calls block until completion; background
 * calls return an agent_id immediately and deliver a completion notification
 * (`customType: "subagent-notification"`, batched at turn boundaries) carrying the
 * final output. agent_send messages flow along tree edges (parent↔child);
 * persistent agents stay resident (idle, zero token) and can be woken by a
 * message.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	SessionManager,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentFooterData, finishedContextUsage, gitBranch } from "./agent-footer.js";
import { type AgentCompletion, AgentProcess, type WakeOutcome } from "./agent-process.js";
import { AgentView } from "./agent-view.js";
import { registerCompletionInbox } from "./completion-inbox.js";
import { canSpawnAt, envInt, loadConfig } from "./config.js";
import { type AgentActivity, type AgentTreeEvent, MSG_STATUS_KEY, TREE_STATUS_KEY } from "./event-interpret.js";
import { createLiveChannels } from "./live-output.js";
import { resolveModel } from "./model.js";
import { completionNotification, maybeWriteFullOutput, questionMessage, truncateForContext } from "./notification.js";
import { type AgentMessage, formatFrom } from "./protocol.js";
import { AgentRegistry, type RegisteredAgent, type WidgetSurface } from "./registry.js";
import { renderNotification, renderQuestion } from "./render.js";
import { Roster } from "./roster.js";
import { persistRoster, rosterFromBranch } from "./roster-state.js";
import { runSpawnSession, type SpawnOutcome } from "./spawn-session.js";
import { fallbackRenderers } from "./transcript.js";
import { createSubtreeDisplay } from "./tree-display.js";
import type { SubagentDetails } from "./types.js";
import { atId, sendView, spawnView, stopView } from "./views.js";
import { AgentWidget } from "./widget.js";

// ─── Running background agents registry ─────────────────────

/** Expand a leading `~` (pi's own expandTildePath only normalizes). */
function expandTilde(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Agent sessions directory: `<agentDir>/subagent-sessions` by default
 * (agentDir honors PI_CODING_AGENT_DIR like pi itself), overridable via
 * PI_SUBAGENT_SESSION_DIR. Kept outside pi's standard session tree so
 * `pi -r` stays clean; resume goes through the main session via the
 * session path on the notification / tool result.
 */
function resolveSubagentSessionDir(): string {
	const override = process.env.PI_SUBAGENT_SESSION_DIR;
	if (override) return expandTilde(override);
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(expandTilde(agentDir), "subagent-sessions");
}

const SUBAGENT_SESSION_DIR = resolveSubagentSessionDir();

// ─── In-tree identity ──────────────────────────────────────

/** This process's agent id ("" = root session). Injected by the parent at spawn. */
const MY_AGENT_ID = process.env.PI_SUBAGENT_AGENT_ID ?? "";
/** I am a child agent when an identity was injected (root children get "a1"…). */
const HAS_PARENT = MY_AGENT_ID !== "";
/** Levels below the main session (0 = the main session), injected by the parent. */
const MY_DEPTH = envInt(process.env.PI_SUBAGENT_DEPTH) ?? (HAS_PARENT ? 1 : 0);

/** Every sub-agent of this conversation, live or finished. */
const roster = new Roster();

/** Live child processes by agent id (foreground, background, resident, revived). */
const processes = new Map<string, AgentProcess>();

/** TUI-only bottom agent list (created lazily, tui mode only). */
let widget: AgentWidget | null = null;

/** Opens the agent view; wired inside the extension entry (needs the registry). */
let openAgent: (agentId: string) => void = () => {};

/** The TUI handle the agent view opens on (refreshed on session start and by commands). */
let viewUi: ExtensionUIContext | undefined;

/**
 * Lazily-captured UI handle for the child→parent channel (extension_ui_request /
 * setStatus under the reserved key). Tool executes refresh it every call,
 * before an outbound @parent message is emitted.
 */
let uiRef: { setStatus(key: string, text: string | undefined): void } | undefined;

function ensureWidget(ctx: { mode: string; ui: unknown }): AgentWidget | null {
	captureUi(ctx);
	if (widget) return widget;
	if (ctx.mode !== "tui") return null;
	viewUi = ctx.ui as ExtensionUIContext;
	widget = new AgentWidget(viewUi, roster, (agentId) => openAgent(agentId));
	return widget;
}

/**
 * Refresh the child→parent handle from any tool execute. Every execute runs
 * with a UI context (rpc children too — their setStatus emits the
 * extension_ui_request event stream the parent consumes). Inbound @parent
 * messages are injected locally and do not use this upward transport.
 */
function captureUi(ctx: { mode: string; ui: unknown }): void {
	uiRef = ctx.ui as { setStatus(key: string, text: string | undefined): void };
}

/** Narrow TUI adapter: AgentWidget → WidgetSurface (registry seam). */
function widgetSurface(): WidgetSurface | null {
	const w = widget;
	if (!w) return null;
	return {
		add: (agent, status) => w.add(agent as AgentProcess, status),
		remove: (agentId, result) => w.remove(agentId, result),
		setStatus: (agentId, status) => w.setStatus(agentId, status),
		dispose: () => w.dispose(),
	};
}

// ─── Tool parameter schemas ──────────────────────────────

/**
 * Tree telemetry (nested agents): a sub-agent's own spawns are invisible to
 * the user — the only TUI is the root session's. Every node reports ALL its
 * spawns upward (foreground and background alike) over the same setStatus
 * transport as @parent messages; intermediate nodes forward verbatim
 * (depth + 1). Consumption is decided at the anchor boundary — the execute
 * that owns the visible surface:
 *   • root + background child → widget rows (indent = depth)
 *   • root + foreground child → folded into that card's nested meta counters
 * A foreground card's subtree therefore never reaches the widget, and a
 * background row's subtree never leaks into a card — one subtree, one
 * surface (SPEC: single-display rule).
 */
function createTreeTelemetry(hasParent: boolean) {
	/** Ids reported as added — guards activity/remove so unknown ids never
	 *  emit telemetry. */
	const tracked = new Set<string>();
	const report = (event: AgentTreeEvent) => uiRef?.setStatus(TREE_STATUS_KEY, JSON.stringify(event));
	return {
		report,
		add(agent: { agentId: string; label: string; startedAt: number }, status: "running" | "idle"): void {
			if (!hasParent) return;
			tracked.add(agent.agentId);
			// `parent` is my own id: I am the direct parent of every child I spawn.
			// Forwarding nodes pass the event through verbatim, so the link stays
			// anchored at the real parent however deep the chain runs.
			report({
				op: "add",
				id: agent.agentId,
				label: agent.label,
				startedAt: agent.startedAt,
				depth: 1,
				status,
				parent: MY_AGENT_ID,
			});
		},
		activity(agent: { agentId: string; getLatestActivity(): AgentActivity | undefined }): void {
			if (!tracked.has(agent.agentId)) return;
			const activity = agent.getLatestActivity();
			if (!activity) return;
			report({ op: "activity", id: agent.agentId, activity });
		},
		remove(agentId: string, status: "done" | "failed" | "stopped"): void {
			if (!tracked.delete(agentId)) return;
			report({ op: "remove", id: agentId, status });
		},
	};
}

/** agent_spawn tool params (schema static shape). */
interface SpawnParams {
	prompt: string;
	label: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	run_in_background?: boolean;
	timeoutMs?: number;
	persistent?: boolean;
}

/** agent_stop tool params. */
interface StopParams {
	agent_id: string;
}

/** agent_send tool params. */
interface SendParams {
	to: string;
	message: string;
}

// Shared agent_spawn parameter fields — the root session gets the full set;
// sub-agents get a foreground-only subset (see buildSpawnParamsSchema).
const SpawnPromptField = Type.String({
	description: "The task for the sub-agent.",
});
const SpawnLabelField = Type.String({
	description: "Task label.",
});
const SpawnModelField = Type.Optional(
	Type.String({
		description:
			'Model for the sub-agent — provider/modelId or fuzzy name (e.g. "haiku", "sonnet"). ' +
			"Omit to inherit your current model.",
	}),
);
const SpawnThinkingField = Type.Optional(
	StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
		description: 'Reasoning intensity for the sub-agent ("off"…"max"). Omit to inherit your current thinking level.',
	}),
);
const SpawnToolsField = Type.Optional(
	Type.Array(Type.String(), {
		description: "Tool allowlist for the sub-agent. Omit to grant all tools. agent_send is always kept.",
	}),
);
const SpawnTimeoutField = Type.Optional(
	Type.Integer({
		minimum: 1,
		description:
			"Optional wall-clock limit per turn, in milliseconds: the task, and each later turn started by " +
			"agent_send. Omit for no time limit. On expiry the agent is stopped and the turn reports stopped.",
	}),
);

/**
 * Sub-agents never see run_in_background: their lifetime is bounded by the
 * parent's synchronous wait, so a background child could not outlive them nor
 * deliver its result anywhere — it would race the returned answer with forced
 * ack turns. Only the long-lived root session hosts background work. Hiding
 * the parameter beats erroring on it: the misuse cannot happen at all.
 *
 * persistent stays available to everyone: its residency is scoped to the host
 * session by definition ("alive until your session ends") — a sub-agent using
 * an iterative helper within its own lifetime is fully served, and parent
 * exit cleans residents up like any other child.
 */
export function buildSpawnParamsSchema(hasParent: boolean): ReturnType<typeof Type.Object> {
	return Type.Object({
		prompt: SpawnPromptField,
		label: SpawnLabelField,
		model: SpawnModelField,
		thinking: SpawnThinkingField,
		tools: SpawnToolsField,
		timeoutMs: SpawnTimeoutField,
		persistent: Type.Optional(
			Type.Boolean({
				description: hasParent
					? "If true, keep the agent resident after it completes (idle, zero token) so follow-up " +
						"messages skip the restart. It closes when its host session exits. Default false."
					: "Keep the agent resident after it completes (idle, zero token) so follow-up messages " +
						"skip the restart. Default true; false exits it when done (agent_send still resumes " +
						"it from its saved session). Resident agents close when their host session exits.",
			}),
		),
		...(hasParent
			? {}
			: {
					run_in_background: Type.Optional(
						Type.Boolean({
							description:
								"Default true in interactive and RPC sessions, false in print/json mode (the host " +
								"exits after its reply). true returns an agent id immediately and the completion " +
								"notification carries the result; false blocks until the result is ready.",
						}),
					),
				}),
	});
}

const SpawnParamsSchema = buildSpawnParamsSchema(HAS_PARENT);

const StopParamsSchema = Type.Object({
	agent_id: Type.String({
		description: 'The agent id whose task to cancel or whose process to explicitly stop (e.g. "@max").',
	}),
});

/**
 * Who agent_send can reach from this process: the root reaches its children;
 * a child that can spawn also reaches @parent; a child at the depth limit
 * (no other agent tools) reaches only @parent.
 */
export type SendReach = "children" | "children+parent" | "parent";

export function sendReach(hasParent: boolean, canSpawn: boolean): SendReach {
	if (!hasParent) return "children";
	return canSpawn ? "children+parent" : "parent";
}

const SEND_TO_DESCRIPTIONS: Record<SendReach, string> = {
	children: 'The agent id from agent_spawn (e.g. "@max" — a spawn result or completion notification carries it).',
	"children+parent":
		'The agent id from agent_spawn (e.g. "@max" — a spawn result or completion ' +
		'notification carries it), or "@parent" to message the agent that spawned you.',
	parent: '"@parent" — the agent that spawned you.',
};

export function buildSendParamsSchema(reach: SendReach): ReturnType<typeof Type.Object> {
	return Type.Object({
		to: Type.String({ description: SEND_TO_DESCRIPTIONS[reach] }),
		message: Type.String({ description: "The message text." }),
	});
}

/** agent_send description: what each reachable target does with a message. */
export function sendDescription(reach: SendReach): string {
	const toChildren =
		"Delivered after the target's current response and tool batch, before its next model request. " +
		"Starts a new model turn for idle children, whose reply arrives as another completion, or resumes exited " +
		"children with recoverable saved sessions. The child's final reply is returned automatically.";
	const toParent =
		"Messages to @parent are only for non-blocking questions; blocking questions and your final report go " +
		"in your final reply. A message to @parent does not end your turn: your parent reads it after its " +
		"current response and tool batch (if it is waiting on your reply, only after that reply ends). Your " +
		"parent's reply appears in your conversation once your current tool calls finish or your turn ends.";
	switch (reach) {
		case "children":
			return `Send a message to a direct child. ${toChildren}`;
		case "children+parent":
			return `Send a message to a direct child, or to @parent. ${toChildren} ${toParent}`;
		case "parent":
			return `Send a message to @parent, the agent that spawned you. ${toParent}`;
	}
}

// ─── Helpers ─────────────────────────────────────────────────

function toErrorResult(err: unknown): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text", text: message }],
		details: { error: message },
		isError: true,
	};
}

/** Spawn-failure tool result: isError + the reason (LLM + user card share it). */
function spawnErrorResult(
	started: { error: string },
	extra: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	return {
		content: [{ type: "text", text: started.error }],
		details: { error: started.error, ...extra },
		isError: true as const,
	};
}

/**
 * Route one in-tree message through the tree (per-hop O(1) against my
 * direct children). Shared by the agent_send tool (outbound: the caller
 * gets a synchronous result) and the inbound handler (child→parent: no
 * return path, so errors are delivered back to the sender as messages).
 *
 *   direct child → rpc prompt + steer (wakes idle, queues on running)
 *   "@parent"   → the parent injects it into its LLM (or mine, inbound)
 *   unknown     → explicit error (routing is the LLM's job, hop by hop);
 *                 on the inbound path the sender is told best-effort
 */
export async function handleMessage(
	pi: ExtensionAPI,
	registry: AgentRegistry,
	msg: AgentMessage,
	outbound: boolean,
): Promise<{ ok: boolean; verb?: string; error?: string }> {
	// @parent is relative to the sender. On the inbound path, this process
	// IS that parent, even at the root where registry.route would reject it.
	if (!outbound && msg.to === "@parent") {
		pi.sendMessage(questionMessage(msg.from, registry.lookup(msg.from)?.label, msg.message), {
			deliverAs: "steer",
			triggerTurn: true,
		});
		return { ok: true, verb: "delivered" };
	}
	const d = registry.route(msg);
	switch (d.kind) {
		case "child": {
			// Point-to-point delivery to a direct child. Cross-level coordination
			// is the LLM's job: it addresses only ids it knows, hop by hop.
			const text = `${formatFrom(d.message.from)}${d.message.message}`;
			const ok = await registry.deliver(d.childId, text);
			return ok ? { ok: true, verb: "delivered" } : { ok: false, error: `delivery to ${d.childId} failed` };
		}
		case "parent": {
			// Outbound only: setStatus is fire-and-forget, not a delivery ACK.
			uiRef?.setStatus(MSG_STATUS_KEY, JSON.stringify(d.message));
			return { ok: true, verb: "sent" };
		}
		case "error": {
			if (!outbound && msg.from) {
				// Inbound path, no return channel: tell the sender (best-effort).
				void registry.deliver(msg.from, `[pi-subagent] agent_send to ${msg.to} failed: ${d.reason}`);
			}
			return { ok: false, error: d.reason };
		}
	}
}

/**
 * Appended to every spawn prompt: the child may not load this extension, so
 * the reply contract travels with the task itself. Two channels up: the final
 * reply (returned automatically) carries the final report and blocking
 * questions; agent_send to @parent (always in a child's allowlist) carries
 * only non-blocking questions, and the child keeps working. A foreground
 * parent is blocked in its agent_spawn call, so it reads such a message only
 * after this reply ends — the note says so instead of promising more.
 */
export function childPromptNote(opts: { foreground: boolean }): string {
	const parts = [
		"Your final reply is returned to your parent automatically. Use it for your final report and for " +
			"blocking questions. When finished, return your result directly; do not send a separate completion " +
			"report. If missing information prevents you from continuing, ask the question and end this reply; " +
			"your parent's answer will resume this conversation.",
		'Use agent_send with to="@parent" only for non-blocking questions, ones you can keep working ' +
			"around while you wait: send the question and keep working. Your parent's reply appears in your " +
			"conversation once your current tool calls finish or your turn ends; you do not need to wait or " +
			"check for it. Do not use agent_send for blocking questions, progress updates, or results.",
	];
	if (opts.foreground) {
		parts.push(
			"Your parent is waiting for this reply and reads agent_send messages only after it ends, so ask " +
				"non-blocking questions in this reply instead.",
		);
	}
	return `\n\n(${parts.join(" ")})`;
}

/** Appended to the output of a turn stopped by timeoutMs. */
const TIME_LIMIT_NOTE = "(stopped \u2014 reached the task time limit; the output above is partial)";

/** Result of a turn the user stopped from the agent view. */
const USER_STOP_NOTE =
	"(stopped by the user from the agent view before it finished; its saved conversation keeps any partial " +
	"work, and agent_send resumes it)";

/** The tools subagent_enable activates (registered with defaultActive: false). */
const SUBAGENT_TOOL_NAMES = ["agent_spawn", "agent_stop", "agent_send"] as const;
const ENABLE_TOOL_NAME = "subagent_enable";
/** The packaged coordination skill (skills/pi-subagents-workflow). */
const WORKFLOW_SKILL_NAME = "pi-subagents-workflow";

/** Whether the transcript's last word on the agent tools is "added" — i.e. the
 *  conversation had enabled them. */
function transcriptEnabledAgentTools(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const message of buildSessionContext(ctx.sessionManager.getBranch()).messages) {
		if (message.role !== "system") continue;
		const m = message as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
		if (m.toolsRemoved?.some((t) => t.name === "agent_spawn")) enabled = false;
		if (m.toolsAdded?.some((t) => t.name === "agent_spawn")) enabled = true;
	}
	return enabled;
}

// ─── Default export (pi extension entry) ───────────────────────

export default function (pi: ExtensionAPI) {
	// Spawn depth limit (pi-subagents.json `maxDepth`, default 1: sub-agents
	// cannot spawn). The main session's limit travels down the tree; at the
	// limit this process registers no spawn/stop tools and nothing to enable,
	// only an @parent-only agent_send in a child, and hides the coordination
	// skill it could not act on.
	const { config, warnings: configWarnings } = loadConfig();
	const maxDepth = envInt(process.env.PI_SUBAGENT_MAX_DEPTH) ?? config.maxDepth;
	const canSpawn = canSpawnAt(MY_DEPTH, maxDepth);
	const childrenCanSpawn = canSpawnAt(MY_DEPTH + 1, maxDepth);
	const registerTool: ExtensionAPI["registerTool"] = canSpawn ? pi.registerTool.bind(pi) : () => {};
	/** Identity and depth for a child process. */
	const childEnv = (agentId: string): NodeJS.ProcessEnv => ({
		PI_SUBAGENT_AGENT_ID: agentId,
		PI_SUBAGENT_DEPTH: String(MY_DEPTH + 1),
		PI_SUBAGENT_MAX_DEPTH: String(maxDepth),
	});
	if (!canSpawn) {
		pi.on("before_agent_start", (event) => {
			event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(
				(skill) => skill.name !== WORKFLOW_SKILL_NAME,
			);
		});
	}

	// pi's agent-core drops the execute() isError flag when a tool returns
	// normally (bash gets its error background by throwing instead) — see
	// agent-core executePreparedToolCall. Re-attach it for our tools by
	// marking every error path in `details.error`; the handler restores
	// isError so failed calls render with toolErrorBg like bash, while
	// keeping the details (status line) intact.
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "agent_spawn" && event.toolName !== "agent_stop" && event.toolName !== "agent_send") {
			return undefined;
		}
		const details = event.details as { error?: unknown } | undefined;
		if (!details || details.error === undefined) return undefined;
		return { isError: true };
	});

	const inbox = registerCompletionInbox(pi);
	const completionSinks = new WeakMap<RegisteredAgent, (completion: AgentCompletion) => void>();
	const bindCompletion = (agent: RegisteredAgent): void => {
		const deliver = inbox.capture();
		completionSinks.set(agent, (completion) => deliver(completionNotification(agent, completion)));
	};
	const notifyCompletion = (agent: RegisteredAgent, completion: AgentCompletion): void => {
		completionSinks.get(agent)?.(completion);
	};

	// One registry per session: owns the running-agent bookkeeping, the
	// completion policy (notify unless user-stopped; cleanup on every path),
	// and the in-tree routing (direct children only — per-hop O(1)).
	const registry = new AgentRegistry({
		notify: notifyCompletion,
		getWidget: () => widgetSurface(),
		hasParent: HAS_PARENT,
	});

	// Inbound messages (a child addresses @parent, forwards a sibling's
	// message, or reports an unroutable target) land here from its rpc event
	// stream and re-enter the router on this hop.
	const onChildMessage = (msg: AgentMessage): void => {
		void handleMessage(pi, registry, msg, false);
	};

	// Tree telemetry for this node's own children (up-report) and forwarding
	// of deeper events. Lives at extension scope: the tracked-set must span
	// executes (a background child reports activity long after its execute returned).
	const tree = createTreeTelemetry(HAS_PARENT);

	/** A wake turn ended: deliver its answer to this session, like a completion. */
	const reportWake = async (agent: AgentProcess, status: WakeOutcome): Promise<void> => {
		const completionId = agent.completionId;
		const durationMs = Date.now() - agent.turnStartedAt;
		const [output, stats] = await Promise.all([agent.lastOutput(), agent.getStats()]);
		notifyCompletion(agent, {
			completionId,
			status,
			output:
				status === "failed"
					? output || agent.errorText || "Follow-up turn failed."
					: status === "stopped"
						? `${output || "Sub-agent was stopped."}\n${TIME_LIMIT_NOTE}`
						: output,
			stats: {
				tokens: stats?.tokens ?? 0,
				toolUses: stats?.toolUses ?? 0,
				// This turn's time, not the agent's lifetime.
				durationMs,
			},
			sessionPath: agent.sessionPath,
			sessionId: agent.sessionId,
		});
	};

	// ── subagent_enable ─────────────────────────────────
	// The three agent tools are registered inactive so a conversation that
	// never delegates carries no schema for them; this
	// parameterless loader activates them on demand (same pattern as
	// web_enable / session_hub_enable). The activation is recorded in the
	// transcript, so a resumed session keeps the tools.
	registerTool({
		name: ENABLE_TOOL_NAME,
		label: "Enable Sub-agents",
		description:
			"Enable the sub-agent tools (agent_spawn, agent_stop, agent_send). Does not spawn anything. " +
			"Enabled tools are available on the next model request. " +
			`For coordination rules, read the ${WORKFLOW_SKILL_NAME} skill if available.`,
		promptSnippet: "Activate agent_spawn, agent_send, and agent_stop",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const unavailable = SUBAGENT_TOOL_NAMES.filter((name) => !registered.has(name));
			if (unavailable.length > 0) throw new Error(`Cannot enable unavailable tools: ${unavailable.join(", ")}.`);
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SUBAGENT_TOOL_NAMES])]);
			const active = new Set(pi.getActiveTools());
			const missing = SUBAGENT_TOOL_NAMES.filter((name) => !active.has(name));
			if (missing.length > 0) throw new Error(`Tools still inactive after activation: ${missing.join(", ")}.`);
			return {
				content: [
					{ type: "text", text: `Enabled: ${SUBAGENT_TOOL_NAMES.join(", ")}. Available on the next model request.` },
				],
				details: { enabled: [...SUBAGENT_TOOL_NAMES] },
			};
		},
	});

	// ── agent_spawn ────────────────────────────────────
	registerTool({
		name: "agent_spawn",
		label: "Agent Spawn",
		defaultActive: false,
		description:
			"Spawn a sub-agent with its own context. Its final reply is returned automatically, including questions. " +
			(HAS_PARENT
				? "Only foreground spawns are available here: the call waits and returns the result. " +
					"Foreground calls can run concurrently; children cannot outlive their host session. "
				: "Background spawns return an agent id immediately. Ready replies enter together after the current " +
					"response and tool batch, before the next model request; an idle parent wakes once for the ready batch. " +
					"Foreground spawns wait and return the result directly. ") +
			(childrenCanSpawn ? `Children can spawn their own sub-agents (maxDepth=${maxDepth}). ` : "") +
			"A child uses agent_send only for non-blocking questions to you; blocking questions and its final " +
			"report come in its final reply. " +
			"Large results are truncated with a path to the full output.",
		promptSnippet: "Start a sub-agent with an independent context",
		parameters: SpawnParamsSchema,

		async execute(_toolCallId, raw, signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as unknown as SpawnParams;
			// Label is cosmetic — it names the session, card, and notifications,
			// and never changes what the agent does.
			const label = params.label?.trim();
			if (!label) {
				return {
					content: [{ type: "text", text: "`label` is required." }],
					details: { error: "`label` is required." },
					isError: true,
				};
			}
			// Schema hides run_in_background from sub-agents; this guard catches
			// hallucinated args (schema validation may pass extras through).
			if (HAS_PARENT && params.run_in_background != null) {
				return {
					content: [
						{
							type: "text",
							text:
								"run_in_background is root-only: your lifetime ends when this call returns, so " +
								"background work could not outlive you nor deliver its result. For parallel " +
								"work, issue several foreground agent_spawn calls together (they run " +
								"concurrently); for long-running work, describe it in your reply so the " +
								"caller can decide.",
						},
					],
					details: { error: "background spawns are root-only", label },
					isError: true,
				};
			}
			const task = params.prompt?.trim();
			if (!task) {
				return {
					content: [{ type: "text", text: "`prompt` is required." }],
					details: { error: "`prompt` is required." },
					isError: true,
				};
			}

			// Root default is background — except in print/json mode, where the
			// host exits after its reply and a background result would be lost.
			const runInBackground = !HAS_PARENT && (params.run_in_background ?? (ctx.mode === "tui" || ctx.mode === "rpc"));

			const resolved = resolveModel(ctx.modelRegistry, ctx.model, params.model);
			if (resolved.error) {
				// Background: render as the status line `Agent <label> start failed:
				// <reason>` (the id never exists yet — spawn didn't happen).
				return {
					content: [{ type: "text", text: resolved.error }],
					details: runInBackground
						? { runInBackground: true, label, error: resolved.error }
						: { error: resolved.error },
					isError: true,
				};
			}

			const startedAt = Date.now();

			// Foreground: stream the sub-agent's session as an ordered activity
			// stream. AgentProcess accumulates RenderEvents internally at the
			// source (RPC event handler); the callbacks here only refresh the
			// live card via onUpdate.
			let streamed = "";
			// Where my child's subtree telemetry lands (SPEC: single-display rule) —
			// fold into THIS card while it's open, forward to my parent, or
			// surface on the root widget. One module owns the whole decision.
			const subtree = createSubtreeDisplay({
				hasParent: HAS_PARENT,
				foregroundEdge: !runInBackground,
				getWidget: () => {
					ensureWidget(ctx);
					return widget ?? undefined;
				},
				forward: (event) => tree.report(event),
				onFold: () =>
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: liveDetails(agent.getLatestActivity()),
					}),
			});
			// Live-card details: the shared slice every foreground update carries.
			const liveDetails = (activity?: AgentActivity): SubagentDetails => ({
				task,
				agentId,
				runInBackground: false,
				persistent: agent.persistent,
				startedAt,
				model: agent.model,
				thinking: agent.thinking,
				activity,
				events: agent.getEvents(),
				nested: subtree.nested(),
			});
			// Short human-name id (max, zoe…) — the LLM-facing reference. No tree
			// structure: agents address only ids they were given, hop by hop.
			const agentId = registry.nextAgentId();
			const live = createLiveChannels({
				// getWidget, not widget: the widget is created on first use, so a
				// captured reference would be null for every update before that.
				surfaces: { getWidget: () => widget ?? undefined, tree },
				...(runInBackground
					? {}
					: {
							card: {
								delta: (text: string) => {
									streamed += text;
									onUpdate?.({
										content: [{ type: "text", text: streamed }],
										details: liveDetails(agent.getLatestActivity()),
									});
								},
								activity: (activity: AgentActivity) => {
									onUpdate?.({ content: [{ type: "text", text: streamed }], details: liveDetails(activity) });
								},
							},
						}),
			});

			const agent = new AgentProcess({
				agentId,
				cwd: ctx.cwd,
				model: resolved.model,
				thinking: params.thinking ?? pi.getThinkingLevel(),
				tools: params.tools,
				label,
				sessionDir: SUBAGENT_SESSION_DIR,
				timeoutMs: params.timeoutMs,
				// Resident after completion (idle, zero token) — explicit opt-in.
				// Root children stay resident by default (follow-ups skip the restart);
				// a sub-agent's own children exit unless asked — agent_send resumes them.
				persistent: params.persistent ?? !HAS_PARENT,
				// Identity for in-tree messaging: PI_SUBAGENT_AGENT_ID marks this
				// process as a child (agent_send is registered on every instance).
				env: childEnv(agentId),
				// Child→parent messages re-enter the router on this hop. Tree telemetry
				// from deeper spawns forwards up (depth + 1) or lands on the root widget.
				onMessage: onChildMessage,
				onTreeEvent: (event) => subtree.onTreeEvent(event),
				// A wake finished. Completed: its output must reach this spawner's
				// context — symmetric with the first-completion notification, an
				// agent_send "delivered" alone would leave the answer unread.
				// Deliberate stops stay silent (stoppedByControl). A failed or
				// timed-out follow-up is reported (abnormal end) then cleaned up.
				// A wake only the user started from the agent view is a side chat:
				// its answer stays in the agent's own session, never reported up.
				onIdle: (outcome) => {
					const reportUp = agent.parentIsWaiting && !agent.stoppedByControl;
					if (outcome === "completed") {
						if (reportUp) void reportWake(agent, "completed").catch(() => {}); // best-effort: must not crash the host
						registry.markIdle(agentId);
						return;
					}
					void (reportUp ? reportWake(agent, outcome) : Promise.resolve())
						.then(() => tree.remove(agentId, outcome))
						.then(() => registry.stopAndRemove(agentId, outcome))
						.catch(() => {}); // best-effort: a cleanup failure must not crash the host
				},
				// Where live output goes lives in live-output.ts: the widget row and
				// the tree fold hear about every update (a woken resident agent has a
				// row and no card), and the card below exists only for a foreground
				// spawn while its tool call runs.
				onDelta: (delta) => live.onDelta(agent, delta),
				onActivityChange: (activity) => live.onActivity(agent, activity),
				onExit: () => {
					if (processes.get(agentId) === agent) processes.delete(agentId);
				},
			});
			bindCompletion(agent);
			processes.set(agentId, agent);
			// The bottom list shows every agent of the conversation, foreground too.
			ensureWidget(ctx);
			roster.upsert({
				agentId,
				label,
				startedAt: agent.startedAt,
				status: "running",
				model: agent.model,
				tools: params.tools,
				timeoutMs: params.timeoutMs,
				cwd: ctx.cwd,
				indent: 0,
			});

			// Lifecycle lives in spawn-session.ts — this switch only formats
			// outcomes into tool results; classification rules are table-tested
			// in test/spawn-session.test.ts.
			let outcome: SpawnOutcome;
			try {
				outcome = await runSpawnSession(agent, {
					task: task + childPromptNote({ foreground: !runInBackground }),
					runInBackground,
					signal,
					hooks: {
						onWorking: () =>
							onUpdate?.({
								content: [{ type: "text", text: "Working\u2026" }],
								details: {
									task,
									agentId,
									runInBackground: false,
									persistent: agent.persistent,
									startedAt,
									model: agent.model,
									thinking: agent.thinking,
								} satisfies SubagentDetails,
							}),
						onBackgroundStarting: () =>
							onUpdate?.({
								content: [{ type: "text", text: `Starting ${agent.label}\u2026` }],
								details: {
									runInBackground: true,
									persistent: agent.persistent,
									agentId,
									label: agent.label,
									model: agent.model,
									thinking: agent.thinking,
								} satisfies SubagentDetails,
							}),
						// Background settled: wire widget + registry + the completion
						// chain here (mechanisms stay on this side of the seam).
						onBackgroundSettled: (a) => {
							roster.upsert({ agentId: a.agentId, sessionPath: (a as AgentProcess).sessionPath });
							ensureWidget(ctx); // widget row added via the registry (non-TUI: no-op)
							registry.register(a as AgentProcess);
							tree.add(a, "running"); // up-report: my child exists
							void a
								.waitForCompletion()
								.then((completion) => {
									tree.remove(
										a.agentId,
										completion.status === "completed" ? "done" : completion.status === "failed" ? "failed" : "stopped",
									);
									registry.complete(a as AgentProcess, completion);
								})
								// Defensive: waitForCompletion is deadline-bounded and never
								// rejects today — if it ever does, clean up without notifying.
								.catch(() => {
									tree.remove(a.agentId, "stopped");
									registry.stopAndRemove(a.agentId);
								});
						},
						onResident: (a) => {
							ensureWidget(ctx);
							// Resident from birth: register the widget row as idle (‖
							// marker, stays addressable). Registering an already-completed
							// agent at its terminal status would be removed by the
							// widget's terminal cleanup before markIdle could flip it.
							registry.register(a as AgentProcess, "idle");
							tree.add(a, "idle");
						},
						// Foreground settled: report the child upward (widget-rooted
						// nodes only — at the root the card itself is the display; a
						// card-contained node's subtree folds at its own anchor). This
						// closes the blind spot where a background agent's foreground
						// children were invisible entirely.
						onForegroundSettled: (a) => {
							roster.upsert({ agentId: a.agentId, sessionPath: (a as AgentProcess).sessionPath });
							if (HAS_PARENT) tree.add(a, "running");
						},
					},
				});
			} catch (err) {
				roster.setStatus(agentId, "failed");
				return toErrorResult(err);
			}

			subtree.closeCard(); // from here on onUpdate cannot refresh the card
			switch (outcome.kind) {
				case "spawn-failed":
					roster.setStatus(agentId, "failed");
					// The isError return carries the failure to the LLM and the status
					// line shows it to the user — no follow-up notification on top.
					return spawnErrorResult(outcome, {
						runInBackground,
						persistent: agent.persistent,
						agentId,
						label: agent.label,
					});

				case "background-started": {
					onUpdate?.({
						content: [{ type: "text", text: `Started ${agent.label} (background)` }],
						details: {
							runInBackground: true,
							persistent: agent.persistent,
							agentId,
							label: agent.label,
							model: agent.model,
							thinking: agent.thinking,
							sessionPath: agent.sessionPath,
							startedAt,
						} satisfies SubagentDetails,
					});
					return {
						content: [
							{
								type: "text",
								text: `Started background agent @${agent.agentId}. Completion arrives as a notification.`,
							},
						],
						details: {
							runInBackground: true,
							persistent: agent.persistent,
							agentId,
							label: agent.label,
							model: agent.model,
							thinking: agent.thinking,
							sessionPath: agent.sessionPath,
							startedAt,
						} satisfies SubagentDetails,
					};
				}

				case "finished": {
					roster.setStatus(
						agentId,
						outcome.resident
							? "idle"
							: outcome.status === "completed"
								? "done"
								: outcome.status === "failed"
									? "failed"
									: "stopped",
					);
					// Failures and limit-stops are both errors for the caller: the
					// stopped case (total timeout / hard token limit) must not look
					// like a clean success. A user cancel (abort) also produces a
					// stop — don't blame that on the limits.
					if (outcome.status === "failed" || outcome.status === "stopped") {
						if (HAS_PARENT && !outcome.resident)
							tree.remove(agentId, outcome.status === "failed" ? "failed" : "stopped");
						const message =
							outcome.status === "failed"
								? outcome.output || "Sub-agent failed."
								: agent.stoppedByUser
									? `${outcome.output ? `${outcome.output}\n` : ""}${USER_STOP_NOTE}`
									: outcome.stoppedByControl
										? outcome.output || "Sub-agent stopped."
										: `${outcome.output || "Sub-agent was stopped."}\n${TIME_LIMIT_NOTE}`;
						return {
							content: [{ type: "text", text: truncateForContext(message) }],
							details: {
								task,
								agentId,
								runInBackground: false,
								persistent: agent.persistent,
								startedAt,
								endedAt: outcome.endedAt,
								// Full message (uncapped) — the user reads it on the card,
								// folded but never dropped; the LLM sees the capped copy.
								error: message,
								model: agent.model,
								thinking: agent.thinking,
								sessionPath: outcome.sessionPath,
								events: outcome.events,
								nested: subtree.nested(),
							} satisfies SubagentDetails,
							isError: true,
						};
					}
					if (HAS_PARENT && !outcome.resident) tree.remove(agentId, "done");
					return {
						// Pure text result — no session hint: the output stands alone
						// (the session path is the card footer, recoverable by the user).
						// A persistent foreground agent stays resident — the LLM needs
						// its id to wake it later with agent_send (or stop it).
						content: [
							{
								type: "text",
								text: outcome.resident
									? `${truncateForContext(outcome.output)}${maybeWriteFullOutput(agent.agentId, outcome.output)}\n\n(agent @${agent.agentId} is idle; agent_send continues its saved conversation and starts a new model turn.)`
									: truncateForContext(outcome.output) + maybeWriteFullOutput(agent.agentId, outcome.output),
							},
						],
						details: {
							task,
							agentId,
							runInBackground: false,
							persistent: agent.persistent,
							sessionPath: outcome.sessionPath,
							sessionId: outcome.sessionId,
							startedAt,
							endedAt: outcome.endedAt,
							model: agent.model,
							thinking: agent.thinking,
							events: outcome.events,
							nested: subtree.nested(),
						} satisfies SubagentDetails,
					};
				}
			}
		},

		...spawnView,
	});

	// ── agent_stop ───────────────────────────────────────
	registerTool({
		name: "agent_stop",
		label: "Stop Agent",
		defaultActive: false,
		description:
			"Cancel a sub-agent's running task and stop its process; for an idle agent, only the process is stopped. " +
			"Saved conversations are not deleted, file changes are not rolled back, and submitted jobs are not cancelled. " +
			"Deliberate stops produce no new completion notification; already completed results remain deliverable.",
		promptSnippet: "Stop a sub-agent process",
		parameters: StopParamsSchema,

		async execute(_toolCallId, raw, _signal, onUpdate) {
			// No captureUi here: agent_stop never sends upward (no child→parent path).
			const params = raw as StopParams;
			// Honour the @ reference form we teach — strip once, use everywhere
			// (lookup, stopAndRemove, details) so no @@ double prefix appears.
			const agentId = params.agent_id.replace(/^@/, "");
			const agent = registry.lookup(agentId);

			if (!agent) {
				// Card title needs the id: details.agentId drives titleFrom (the
				// args key is snake_case agent_id, which titleFrom does not read).
				return {
					content: [{ type: "text", text: `agent ${params.agent_id} not found or already finished.` }],
					details: { agentId, error: `agent ${params.agent_id} not found or already finished` },
					isError: true,
				};
			}

			// Partial update first — drives the `⠋ agent_stop <label> stopping…`
			// spinner line while the child is being stopped.
			onUpdate?.({
				content: [{ type: "text", text: `Stopping ${agent.label}\u2026` }],
				details: { label: agent.label, agentId },
			});
			try {
				const stopped = await registry.stopAndRemove(agentId);
				if (stopped) tree.remove(agentId, "stopped");
				if (!stopped) {
					// Finished between lookup and removal (rare) — don't claim
					// a stop that never happened.
					const message = `agent ${params.agent_id} already finished.`;
					return {
						content: [{ type: "text", text: message }],
						details: { agentId, label: agent.label, error: message },
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: `Stopped agent @${agentId}.` }],
					details: { agentId, label: agent.label },
				};
			} catch (err) {
				// Child died mid-stop (e.g. write-after-end): surface it as a
				// proper status line, not a bare thrown error.
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: message }],
					details: { agentId, label: agent.label, error: message },
					isError: true,
				};
			}
		},

		...stopView,
	});

	// ── agent_send ──────────────────────────────────────
	// Every child gets agent_send, active from the start: messaging its parent
	// is independent of spawning, so a child at the depth limit keeps this one
	// tool, restricted to @parent.
	const reach = sendReach(HAS_PARENT, canSpawn);
	(HAS_PARENT ? pi.registerTool.bind(pi) : registerTool)({
		name: "agent_send",
		label: "Send Message",
		defaultActive: HAS_PARENT,
		description: sendDescription(reach),
		promptSnippet:
			reach === "parent" ? "Send a message to your parent agent" : "Send a message to an existing sub-agent",
		parameters: buildSendParamsSchema(reach),

		async execute(_toolCallId, raw, _signal, onUpdate, ctx) {
			captureUi(ctx);
			const params = raw as unknown as SendParams;
			const to = params.to?.trim();
			const message = params.message?.trim();
			// Honour the @ reference form we teach — but never strip @parent
			// (the protocol layer routes on the literal value). Plain agent
			// ids get stripped once, so lookup and the card title resolve and
			// no @@ double prefix appears.
			const target = to ? (to === "@parent" ? to : to.replace(/^@/, "")) : to;
			if (!to) {
				return {
					content: [{ type: "text", text: "`to` is required." }],
					details: { error: "`to` is required." },
					isError: true,
				};
			}
			if (!message) {
				return {
					content: [{ type: "text", text: "`message` is required." }],
					details: { error: "`message` is required." },
					isError: true,
				};
			}

			if (reach === "parent" && target !== "@parent") {
				const error = 'Only "@parent" is reachable from this agent.';
				return { content: [{ type: "text", text: error }], details: { to: target, error }, isError: true };
			}
			onUpdate?.({
				content: [{ type: "text", text: `Sending to ${atId(target)}\u2026` }],
				details: { to: target },
			});
			// A finished child is revived from its session with the message as
			// its next turn; the answer comes back as a notification.
			if (target !== "@parent" && isRevivable(target)) {
				const label = roster.get(target)?.label;
				const error = await revive(target, `${formatFrom(MY_AGENT_ID)}${message}`, ctx.cwd, "parent");
				if (error) {
					return {
						content: [{ type: "text", text: `Could not resume ${atId(target)}: ${error}` }],
						details: { to: target, label, agentId: target, error },
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Resumed ${atId(target)} with its previous context and delivered the message. Its answer arrives as a notification.`,
						},
					],
					details: { to: target, message, label, agentId: target },
				};
			}
			const r = await handleMessage(pi, registry, { to: target, from: MY_AGENT_ID, message }, true);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: r.error ?? "delivery failed" }],
					details: { to: target, error: r.error },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `${r.verb} to ${atId(target)}.` }],
				// Card title shows @id — target label (uniform with agent_stop).
				details: {
					to: target,
					message,
					label: registry.lookup(target)?.label,
					agentId: registry.lookup(target)?.agentId,
				},
			};
		},

		...sendView,
	});

	// ── Agent view (bottom list click / /agents) ──────────
	// Renderers the main transcript resolved, so a child's bash/read/edit
	// calls render like pi's own; our three tools render with their views.
	const rendererCache = new Map<string, ToolRenderers>([
		["agent_spawn", spawnView as ToolRenderers],
		["agent_stop", stopView as ToolRenderers],
		["agent_send", sendView as ToolRenderers],
	]);
	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		if (renderers && !rendererCache.has(toolName)) rendererCache.set(toolName, renderers);
		return renderers;
	});

	/** The main session's model registry: the view footer resolves a finished
	 *  child's model and counts providers with it. Refreshed on session events. */
	let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
	const NO_STATUSES: ReadonlyMap<string, string> = new Map();

	/**
	 * What the agent view's footer shows: pi's footer lines for the child.
	 * Usage totals come from its session file; model, thinking and context
	 * usage from the live process, else from what the session recorded.
	 */
	const loadFooter = async (agentId: string, branch: Promise<string | null>): Promise<AgentFooterData | undefined> => {
		const live = processes.get(agentId);
		const alive = live?.isAlive ? live : undefined;
		const sessionPath = alive?.sessionPath ?? roster.get(agentId)?.sessionPath;
		if (!sessionPath) return undefined;
		const sessionManager = SessionManager.open(sessionPath);
		const [state, liveContext, gitBranchName] = await Promise.all([
			alive?.getState(),
			alive?.getContextUsage(),
			branch,
		]);
		let model = state?.model;
		let thinkingLevel = state?.thinkingLevel;
		if (!model || !thinkingLevel) {
			const recorded = buildSessionContext(sessionManager.getBranch());
			if (!model && recorded.model) model = modelRegistry?.find(recorded.model.provider, recorded.model.modelId);
			thinkingLevel ??= recorded.thinkingLevel;
		}
		const registry = modelRegistry;
		return {
			sessionManager,
			model,
			thinkingLevel,
			contextUsage: liveContext ?? (alive ? undefined : finishedContextUsage(sessionManager, model)),
			autoCompactionEnabled: state?.autoCompactionEnabled ?? true,
			gitBranch: gitBranchName,
			providerCount: registry ? new Set(registry.getAvailable().map((m) => m.provider)).size : 1,
			isUsingSubscription: (provider) => !!model && model.provider === provider && !!registry?.isUsingOAuth(model),
			statuses: () => {
				const current = processes.get(agentId);
				return current?.isAlive ? current.getStatuses() : NO_STATUSES;
			},
		};
	};

	/** The conversation so far: the live child's, else its session file's. */
	const loadMessages = async (agentId: string): Promise<unknown[]> => {
		const live = processes.get(agentId);
		if (live?.isAlive) {
			const messages = await live.getMessages();
			if (messages) return messages;
		}
		const sessionPath = roster.get(agentId)?.sessionPath;
		if (!sessionPath) return [];
		return buildSessionContext(SessionManager.open(sessionPath).getBranch()).messages;
	};

	/**
	 * Bring a finished agent back from its session file with a message as its
	 * next turn. It stays resident afterwards (idle between turns), addressable
	 * by agent_send and agent_stop like any persistent agent. A turn the parent
	 * started (agent_send) reports its answer here like a completion; a turn
	 * the user started in the agent view is a side chat and reports nothing.
	 */
	const revive = async (
		agentId: string,
		text: string,
		cwd: string,
		origin: "parent" | "user",
	): Promise<string | undefined> => {
		const entry = roster.get(agentId);
		if (!entry?.sessionPath) return "This agent has no session file to resume.";
		const subtree = createSubtreeDisplay({
			hasParent: HAS_PARENT,
			foregroundEdge: false,
			getWidget: () => widget ?? undefined,
			forward: (event) => tree.report(event),
			onFold: () => {},
		});
		const live = createLiveChannels({ surfaces: { getWidget: () => widget ?? undefined, tree } });
		const agent: AgentProcess = new AgentProcess({
			agentId,
			label: entry.label,
			cwd: entry.cwd ?? cwd,
			tools: entry.tools,
			timeoutMs: entry.timeoutMs,
			persistent: true,
			resumeSession: entry.sessionPath,
			env: childEnv(agentId),
			onMessage: onChildMessage,
			onTreeEvent: (event) => subtree.onTreeEvent(event),
			onIdle: (outcome) => {
				const reportUp = agent.parentIsWaiting && !agent.stoppedByControl;
				if (outcome === "completed") {
					if (reportUp) void reportWake(agent, "completed").catch(() => {});
					registry.markIdle(agentId);
					return;
				}
				void (reportUp ? reportWake(agent, outcome) : Promise.resolve())
					.then(() => registry.stopAndRemove(agentId, outcome))
					.catch(() => {});
			},
			onDelta: (delta) => live.onDelta(agent, delta),
			onActivityChange: (activity) => live.onActivity(agent, activity),
			onExit: () => {
				if (processes.get(agentId) === agent) processes.delete(agentId);
			},
		});
		bindCompletion(agent);
		processes.set(agentId, agent);
		const started = await agent.spawnAndSend(text, origin);
		if (!started.ok) {
			processes.delete(agentId);
			await agent.stop().catch(() => {});
			return started.error;
		}
		registry.register(agent, "running");
		roster.upsert({ agentId, status: "running", endedAt: undefined });
		void agent
			.waitForCompletion()
			.then(async (completion) => {
				// The parent waited on it: the completion policy notifies and keeps it resident.
				if (completion.owedToParent) await registry.complete(agent, completion);
				else if (completion.status === "completed") registry.markIdle(agentId);
				else await registry.stopAndRemove(agentId, completion.status === "failed" ? "failed" : "stopped");
			})
			.catch(() => {});
		return undefined;
	};

	/** A direct child whose process is gone but whose session can be resumed. */
	const isRevivable = (agentId: string): boolean => {
		const entry = roster.get(agentId);
		return !!entry?.sessionPath && entry.indent === 0 && !registry.lookup(agentId) && !processes.get(agentId)?.isAlive;
	};

	/** Deliver a message typed in the agent view. */
	const sendFromView = async (agentId: string, text: string, cwd: string): Promise<string | undefined> => {
		const live = processes.get(agentId);
		if (!live?.isAlive) return revive(agentId, text, cwd, "user");
		const wasIdle = roster.get(agentId)?.status === "idle";
		const ok = await live.sendMessage(text, "user");
		if (!ok) return "Delivery failed.";
		if (wasIdle) roster.setStatus(agentId, "running");
		return undefined;
	};

	/**
	 * The user stopped an agent from its view. Like agent_stop it ends the
	 * process and keeps the saved session (agent_send resumes it). Unlike
	 * agent_stop the parent did not ask for it, so a parent still waiting on
	 * the turn is told; an idle agent owes nothing and stops silently.
	 */
	const stopFromView = async (agentId: string): Promise<string | undefined> => {
		const agent = processes.get(agentId);
		if (!agent?.isAlive) return "Not running.";
		agent.stoppedByUser = true;
		if (!registry.lookup(agentId)) {
			// Foreground: its agent_spawn call is waiting and returns the stop.
			await agent.stop();
			return undefined;
		}
		const owed = agent.status === "running" && agent.parentIsWaiting;
		const completionId = agent.completionId;
		const durationMs = Date.now() - agent.turnStartedAt;
		await registry.stopAndRemove(agentId);
		tree.remove(agentId, "stopped");
		if (owed) {
			notifyCompletion(agent, {
				completionId,
				status: "stopped",
				output: USER_STOP_NOTE,
				stats: { tokens: 0, toolUses: 0, durationMs },
				sessionPath: agent.sessionPath,
				sessionId: agent.sessionId,
			});
		}
		return undefined;
	};

	let viewOpen = false;
	openAgent = (agentId: string) => {
		const ui = viewUi;
		if (!ui || viewOpen || !roster.get(agentId)) return;
		viewOpen = true;
		const cwd = roster.get(agentId)?.cwd ?? process.cwd();
		// Once per view: the branch rarely changes while it is open.
		const branch = gitBranch(cwd);
		void ui
			.custom<void>(
				(tui, theme, keybindings, done) =>
					new AgentView(
						tui,
						theme,
						keybindings,
						{
							agentId,
							cwd,
							entry: () => roster.get(agentId),
							subscribe: (listener) => processes.get(agentId)?.subscribe(listener),
							processKey: () => processes.get(agentId),
							loadMessages: () => loadMessages(agentId),
							send: (text) => sendFromView(agentId, text, cwd),
							canStop: () => processes.get(agentId)?.isAlive === true,
							footer: () => loadFooter(agentId, branch),
							stop: () => stopFromView(agentId),
							onRosterChange: (listener) => roster.onChange(listener),
							renderers: (toolName) => rendererCache.get(toolName) ?? fallbackRenderers(toolName),
						},
						() => done(undefined),
					),
				{ overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 } },
			)
			.finally(() => {
				viewOpen = false;
			});
	};

	pi.registerCommand("agents", {
		description: "List this conversation's sub-agents and open one (/agents [id])",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/agents needs the interactive TUI.", "warning");
				return;
			}
			viewUi = ctx.ui;
			modelRegistry = ctx.modelRegistry;
			ensureWidget(ctx);
			const entries = roster.list();
			if (entries.length === 0) {
				ctx.ui.notify("No sub-agents in this conversation yet.", "info");
				return;
			}
			const wanted = args.trim().replace(/^@/, "");
			if (wanted && roster.get(wanted)) {
				openAgent(wanted);
				return;
			}
			const options = entries.map((e) => `${"  ".repeat(e.indent)}${atId(e.agentId)} \u2014 ${e.label}  (${e.status})`);
			const picked = await ctx.ui.select("Sub-agents", options);
			if (picked === undefined) return;
			const entry = entries[options.indexOf(picked)];
			if (entry) openAgent(entry.agentId);
		},
	});

	// ── Notification card (user side) ───────────────────
	pi.registerMessageRenderer("subagent-notification", renderNotification);
	pi.registerMessageRenderer("subagent-message", renderQuestion);

	// ── Cleanup on exit ─────────────────────────────────
	// A resumed (or /tree-navigated) conversation that had enabled the agent
	// tools gets them back: pi rebuilds the active set from registration
	// defaults, which would otherwise record their removal on the next turn.
	const restoreAgentTools = (ctx: ExtensionContext): void => {
		if (!canSpawn) return;
		try {
			if (!transcriptEnabledAgentTools(ctx)) return;
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SUBAGENT_TOOL_NAMES])]);
		} catch {
			// Best effort: the loader stays available to re-enable them.
		}
	};
	// Restore from the full selected branch, not the compacted model context.
	let unsubscribePersistence: (() => void) | undefined;
	const rebuildRoster = (ctx: ExtensionContext): void => {
		unsubscribePersistence?.();
		unsubscribePersistence = undefined;
		let entries: ReturnType<typeof rosterFromBranch> = [];
		try {
			entries = rosterFromBranch(ctx.sessionManager.getBranch(), ctx.cwd);
		} catch (err) {
			if (ctx.mode === "tui") ctx.ui.notify(`Could not restore sub-agents: ${String(err)}`, "warning");
		}
		roster.reset(entries);
		for (const agent of processes.values()) {
			if (!agent.isAlive) continue;
			roster.upsert({
				agentId: agent.agentId,
				label: agent.label,
				startedAt: agent.startedAt,
				status: agent.status === "running" ? "running" : "idle",
				sessionPath: agent.sessionPath,
				model: agent.model,
				indent: 0,
			});
		}
		registry.reserveIds(roster.list().map((e) => e.agentId));
		if (ctx.mode === "tui") {
			// Pi clears widgets on reload/session changes. Re-register on the
			// fresh UI even if the extension module's old instance was cached.
			widget?.dispose();
			widget = null;
			viewUi = ctx.ui;
			ensureWidget(ctx);
		}
		unsubscribePersistence = persistRoster(
			roster,
			(type, data) => pi.appendEntry(type, data),
			(error) => {
				if (ctx.mode === "tui") ctx.ui.notify(`Could not save sub-agent list: ${String(error)}`, "warning");
			},
		);
	};
	pi.on("session_start", (_event, ctx) => {
		modelRegistry = ctx.modelRegistry;
		restoreAgentTools(ctx);
		rebuildRoster(ctx);
		if (ctx.mode === "tui") for (const warning of configWarnings) ctx.ui.notify(`pi-subagents: ${warning}`, "warning");
	});
	pi.on("session_tree", (_event, ctx) => {
		modelRegistry = ctx.modelRegistry;
		restoreAgentTools(ctx);
		rebuildRoster(ctx);
	});

	pi.on("session_shutdown", async () => {
		unsubscribePersistence?.();
		unsubscribePersistence = undefined;
		// Every reason ends this runtime's ownership of its children. Quit: the
		// process is ending. Reload and session replacement (new / resume /
		// fork): pi builds a new extension runtime in the same process and
		// fires this on the OLD one first, so this handler still owns the
		// registry. The inbox closes with the session, so a child left running
		// could never deliver again — and residency is scoped to the host
		// session (SPEC). Saved sessions stay; agent_send can resume them.

		// Graceful stop of every agent, registered or not (a foreground child
		// whose tool call is still open). Children exit on their own (stdin
		// EOF → rpc shutdown) even if the parent dies first, because the pipe
		// closes — no tmux, no disk cleanup, no signals.
		const live = [...processes.values()];
		await registry.shutdown();
		for (const agent of live) void agent.stop().catch(() => {});
		processes.clear();
		widget?.dispose();
		widget = null;
	});
}
