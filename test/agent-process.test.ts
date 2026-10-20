/**
 * Tests for AgentProcess semantics (agent-process.ts).
 *
 * The stateful transport (rpc-client.ts) is NOT tested — a fake client is
 * injected via the `createClient` seam so we can drive the state machine
 * deterministically: spawnAndSend → settle → completion,
 * hard abort, external stop, and failure paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentProcess, type AgentProcessOptions } from "../agent-process.js";
import type { AgentActivity } from "../event-interpret.js";
import type { RpcResponse } from "../protocol.js";
import { AgentRegistry } from "../registry.js";
import type { RpcClientOptions } from "../rpc-client.js";

/** Programmable fake standing in for RpcClient. */
class FakeClient {
	commands: Array<{ type: string; message?: string }> = [];
	endInputCalls = 0;
	killCalls = 0;
	exitCode: number | null = null;
	exitSignal: NodeJS.Signals | null = null;
	isClosed = false;
	closeOnEnd = true;
	promptDisposition: "started" | "queued" | "handled" = "started";
	/** argv captured at construction (--model/--tools/--session-dir). */
	args: string[] = [];
	/** env captured at construction (identity injection). */
	env: NodeJS.ProcessEnv | undefined;

	private onEvent?: (event: { type: string }) => void;
	private onExit?: () => void;
	private exitResolve!: (v: { code: number | null; signal: string | null }) => void;
	private exitPromise = new Promise<{ code: number | null; signal: string | null }>((r) => {
		this.exitResolve = r;
	});

	/** Simulated session stats returned by get_session_stats. */
	stats: { tokens: number; toolCalls: number } = { tokens: 100, toolCalls: 2 };
	/** Simulated preflight result. */
	promptOk = true;
	/** Simulated last assistant text. */
	lastText = "final answer";
	/** Simulated captured stderr (crash root cause). */
	stderrText = "";
	/** sessionFile/sessionId returned by get_state. */
	sessionFile = "/tmp/fake.jsonl";
	sessionId = "sess-1";

	constructor(options: RpcClientOptions) {
		this.onEvent = options.onEvent;
		this.onExit = options.onExit;
		this.args = options.args;
		this.env = options.env;
	}

	async sendCommand(
		command: { type: string; message?: string },
		onResponse?: (response: RpcResponse) => void,
	): Promise<RpcResponse> {
		const response = await this.response(command);
		onResponse?.(response);
		return response;
	}

	private async response(command: { type: string; message?: string }): Promise<RpcResponse> {
		this.commands.push(command);
		switch (command.type) {
			case "prompt":
				return this.promptOk
					? { type: "response", command: "prompt", success: true, data: { disposition: this.promptDisposition } }
					: { type: "response", command: "prompt", success: false, error: "preflight failed" };
			case "get_state":
				return {
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionFile: this.sessionFile, sessionId: this.sessionId },
				};
			case "get_session_stats":
				return {
					type: "response",
					command: "get_session_stats",
					success: true,
					data: { tokens: { total: this.stats.tokens }, toolCalls: this.stats.toolCalls },
				};
			case "get_last_assistant_text":
				return {
					type: "response",
					command: "get_last_assistant_text",
					success: true,
					data: { text: this.lastText },
				};
			case "abort":
				return { type: "response", command: command.type, success: true };
			default:
				return { type: "response", command: command.type, success: true };
		}
	}

	emitSettled(): void {
		this.onEvent?.({ type: "agent_settled" });
	}

	emitEvent(event: {
		type: string;
		assistantMessageEvent?: {
			type: string;
			delta?: unknown;
			toolCall?: { id?: unknown; name?: unknown; arguments?: unknown };
		};
		messages?: Array<{ role?: string; stopReason?: string; errorMessage?: unknown; content?: unknown[] }>;
		willRetry?: boolean;
		message?: {
			role?: string;
			content?: Array<{
				type?: string;
				text?: unknown;
				thinking?: unknown;
				name?: unknown;
				arguments?: unknown;
				id?: unknown;
			}>;
		};
	}): void {
		this.onEvent?.(event as never);
	}

	emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.exitSignal = signal;
		this.isClosed = true;
		this.onExit?.();
		this.exitResolve({ code, signal });
	}

	endInput(): void {
		this.endInputCalls++;
		if (this.closeOnEnd) this.emitExit(0);
	}

	kill(): void {
		this.killCalls++;
	}

	waitForExit(): Promise<{ code: number | null; signal: string | null }> {
		return this.exitPromise;
	}
}

function makeAgent(options: Partial<AgentProcessOptions> & { cwd: string }): { agent: AgentProcess; fake: FakeClient } {
	let fake!: FakeClient;
	const agent = new AgentProcess(
		{ ...options, agentId: options.agentId ?? "a1", label: options.label ?? "test agent" },
		{
			createClient: (opts: RpcClientOptions) => {
				fake = new FakeClient(opts);
				return fake as never;
			},
		},
	);
	return { agent, fake };
}

describe("AgentProcess — spawnAndSend", () => {
	it("moves to running and captures session info on prompt ack", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", label: "my task" });
		const started = await agent.spawnAndSend("do it");
		assert.deepEqual(started, { ok: true });
		assert.equal(agent.status, "running");
		assert.equal(agent.sessionPath, "/tmp/fake.jsonl");
		assert.equal(agent.sessionId, "sess-1");
		assert.ok(agent.agentId.length > 0);
		// prompt + get_state commands were sent
		assert.deepEqual(
			fake.commands.map((c) => c.type),
			["prompt", "get_state"],
		);
	});

	it("fails with the preflight error and stays failed", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptOk = false;
		const started = await agent.spawnAndSend("do it");
		assert.deepEqual(started, { ok: false, error: "preflight failed" });
		assert.equal(agent.status, "failed");
	});

	it("passes model/tools/sessionDir through and sets --name when label is given", () => {
		const { fake } = makeAgent({
			cwd: "/tmp",
			model: "google/gemini-x",
			tools: ["read", "grep"],
			label: "explore",
			sessionDir: "/example/user/.pi/agent/subagent-sessions",
		});
		assert.deepEqual(fake.args, [
			"--model",
			"google/gemini-x",
			"--tools",
			"read,grep,agent_send",
			"--name",
			"explore",
			"--session-dir",
			"/example/user/.pi/agent/subagent-sessions",
		]);
	});

	it("keeps agent_send in every allowlist without duplicating it", () => {
		const listed = makeAgent({ cwd: "/tmp", label: "x", tools: ["agent_send", "read"] }).fake.args;
		assert.deepEqual(listed.slice(0, 2), ["--tools", "agent_send,read"]);
		const revived = makeAgent({ cwd: "/tmp", label: "x", tools: ["read"], resumeSession: "/s.jsonl" }).fake.args;
		assert.deepEqual(revived.slice(0, 2), ["--tools", "read,agent_send"]);
		assert.deepEqual(makeAgent({ cwd: "/tmp", label: "x", tools: [] }).fake.args.slice(0, 2), [
			"--tools",
			"agent_send",
		]);
		assert.ok(!makeAgent({ cwd: "/tmp", label: "x" }).fake.args.includes("--tools"));
	});

	for (const resumeSession of [undefined, "/saved/session.jsonl"]) {
		it(`deduplicates extra --extension paths (${resumeSession ? "resume" : "new session"})`, () => {
			const extensions = ["/example/bridge.ts", "/example/path with spaces.ts", "/example/bridge.ts"];
			const { fake } = makeAgent({ cwd: "/tmp", label: "x", extensions, resumeSession });
			assert.deepEqual(fake.args, [
				"--extension",
				"/example/bridge.ts",
				"--extension",
				"/example/path with spaces.ts",
				...(resumeSession ? ["--session", resumeSession] : ["--name", "x"]),
			]);
			assert.equal(extensions.length, 3, "does not mutate caller data");
		});

		it(`omits extra CLI arguments by default (${resumeSession ? "resume" : "new session"})`, () => {
			const expected = resumeSession ? ["--session", resumeSession] : ["--name", "x"];
			for (const extensions of [undefined, []]) {
				assert.deepEqual(makeAgent({ cwd: "/tmp", label: "x", extensions, resumeSession }).fake.args, expected);
			}
		});
	}

	it("passes thinking level through as --thinking", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", label: "explore", thinking: "high" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--thinking", "high", "--name", "explore"]);
	});

	it("omits --thinking when no level is given (inherit main session)", () => {
		const { fake } = makeAgent({ cwd: "/tmp", model: "google/gemini-x", label: "explore" });
		assert.deepEqual(fake.args, ["--model", "google/gemini-x", "--name", "explore"]);
	});
});

describe("AgentProcess — waitForCompletion", () => {
	it("completes after the first settle", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
		assert.equal(completion.output, "final answer");
		assert.equal(completion.stats.tokens, 100);
		assert.equal(completion.stats.toolUses, 2);
		assert.ok(completion.stats.durationMs >= 0);
		assert.equal(completion.sessionPath, "/tmp/fake.jsonl");
	});

	it("hard-stops a child that never settles after timeout", async () => {
		const { agent, fake } = makeAgent({
			cwd: "/tmp",
			timeoutMs: 30,
			abortSettleGraceMs: 20,
		});
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion(); // no settle ever arrives

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
		assert.ok(
			fake.commands.some((c) => c.type === "abort"),
			"abort was sent",
		);
		assert.equal(fake.endInputCalls, 1, "child was hard-stopped via stdin EOF");
		assert.equal(agent.stoppedByControl, false, "timeout escalation is not a user-controlled stop");
	});

	it("does not hard-stop when the child settles within the abort grace window", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", timeoutMs: 30, abortSettleGraceMs: 500 });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		await new Promise((r) => setTimeout(r, 40)); // deadline passes → abort
		fake.emitSettled(); // settles inside the grace window

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
		assert.equal(fake.endInputCalls, 0, "grace settle avoids the hard stop");
	});

	it("waits forever when no timeoutMs is given (no hidden deadline)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		// No settle, no explicit timeout — the wait must stay pending rather
		// than escalating to an abort/stop. Probe for a spell, then release.
		let resolved = false;
		const completionPromise = agent.waitForCompletion().then((c) => {
			resolved = true;
			return c;
		});
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(resolved, false, "no deadline → no automatic stop");
		assert.ok(!fake.commands.some((c) => c.type === "abort"), "no abort was sent");

		fake.emitSettled();
		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
	});

	it("marks failed when the child exits non-zero without settling", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1); // crash — no settle, onExit releases waiters

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
	});

	it("surfaces captured stderr as the output when a failed child left no text", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = ""; // no assistant output before the crash
		fake.stderrText = "FATAL: bad API key";

		const completionPromise = agent.waitForCompletion();
		fake.emitExit(1);

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "FATAL: bad API key");
	});
});

describe("AgentProcess — onDelta", () => {
	it("streams text_delta events from message_update", async () => {
		const deltas: string[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onDelta: (d) => deltas.push(d) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Hello " },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "World" },
		});
		fake.emitEvent({ type: "agent_settled" });

		assert.deepEqual(deltas, ["Hello ", "World"]);
	});

	it("ignores non-delta message updates", async () => {
		const deltas: string[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onDelta: (d) => deltas.push(d) });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
		assert.deepEqual(deltas, []);
	});
});

describe("AgentProcess — agent API errors", () => {
	it("marks failed with the API error when agent_end reports stopReason error", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = ""; // error turn produces no assistant text

		const completionPromise = agent.waitForCompletion();
		fake.emitEvent({
			type: "agent_end",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limited" },
			],
		});
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "429 Rate limited");
	});

	for (const persistent of [false, true]) {
		it(`clears a recovered overflow error before settlement (persistent=${persistent})`, async () => {
			const outcomes: string[] = [];
			const { agent, fake } = makeAgent({ cwd: "/tmp", persistent, onIdle: (o) => outcomes.push(o) });
			await agent.spawnAndSend("do it");
			if (persistent) {
				const initial = agent.waitForCompletion();
				fake.emitSettled();
				await initial;
				await agent.sendMessage("continue");
			}
			const completionId = agent.completionId;
			fake.emitEvent({
				type: "agent_end",
				willRetry: false, // overflow recovery is not covered by the transient retry flag
				messages: [{ role: "assistant", stopReason: "error", errorMessage: "Context window exceeded" }],
			});
			assert.equal(agent.status, "running");
			fake.emitEvent({ type: "compaction_start" });
			fake.emitEvent({ type: "compaction_end", willRetry: true });
			fake.emitEvent({ type: "agent_start" });
			fake.emitEvent({
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop" }],
			});
			assert.deepEqual(outcomes, [], "no completion until Pi settles");
			fake.emitSettled();
			const completion = await agent.completionSnapshot();
			assert.equal(completion.status, "completed");
			assert.equal(completion.output, "final answer");
			assert.equal(completion.completionId, completionId, "recovery is still the same parent-owned turn");
			assert.equal(agent.errorText, "");
			assert.deepEqual(outcomes, persistent ? ["completed"] : []);
		});
	}

	it("keeps an unrecovered overflow error when compaction never produces a successful run", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = "";
		fake.emitEvent({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "Context window exceeded" }],
		});
		fake.emitEvent({ type: "compaction_end", willRetry: false });
		fake.emitSettled();
		const completion = await agent.waitForCompletion();
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "Context window exceeded");
	});

	it("reports the final error even after an earlier successful run", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");
		fake.lastText = "";
		fake.emitEvent({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
		fake.emitEvent({ type: "agent_start" });
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "Final API error" }],
		});
		fake.emitSettled();
		const completion = await agent.waitForCompletion();
		assert.equal(completion.status, "failed");
		assert.equal(completion.output, "Final API error");
	});

	it("stays completed when agent_end has no error stop reason", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
		});
		fake.emitSettled();

		const completion = await completionPromise;
		assert.equal(completion.status, "completed");
	});
});

describe("AgentProcess — latest activity", () => {
	it("tracks streamed text as the latest activity", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "Found 5 files" },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "text", text: "Found 5 files" });
	});

	it("tracks thinking while the agent is reasoning", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "Let me analyze the structure" },
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "thinking", text: "" });
	});

	it("summarizes tool calls with the friendly argument key", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { name: "bash", arguments: { command: "sleep 20" } },
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", name: "bash", args: "sleep 20" });
	});

	it("summarizes tool calls with JSON when no friendly key exists", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { name: "custom_tool", arguments: { foo: 1 } },
			},
		});
		assert.deepEqual(agent.getLatestActivity(), { kind: "tool", name: "custom_tool", args: '{"foo":1}' });
	});

	it("returns undefined before any message_update", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		assert.equal(agent.getLatestActivity(), undefined);
	});

	it("fires onActivityChange for thinking and tool transitions", async () => {
		const events: AgentActivity[] = [];
		const { fake } = makeAgent({ cwd: "/tmp", onActivityChange: (a) => events.push(a) });

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "analyzing…" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "done" },
		});

		assert.deepEqual(events, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "bash", args: "ls" },
		]);
	});

	it("records every tool call and collapses consecutive thinking", async () => {
		const events: AgentActivity[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", onActivityChange: (a) => events.push(a) });

		// Two thinking_delta deltas → one thinking marker (dedup).
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "one" } });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "two" } });
		// Two bash calls → two tool rows, both recorded.
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "read", arguments: { path: "a.ts" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "read", arguments: { path: "b.ts" } } },
		});

		assert.deepEqual(events, [
			{ kind: "thinking", text: "" },
			{ kind: "tool", name: "read", args: "a.ts" },
			{ kind: "tool", name: "read", args: "b.ts" },
		]);
		assert.deepEqual(
			agent.getEvents().map((e) => e.kind),
			["thinking", "tool", "tool"],
		);
	});

	it("accumulates thinking, tool, and text events in order", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const starter = agent.spawnAndSend("prompt");
		fake.emitEvent({ type: "agent_settled" }); // acks spawn
		await starter;

		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "reasoning..." },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "bash", arguments: { command: "ls" } } },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: " world" },
		});

		assert.deepEqual(agent.getEvents(), [
			{ kind: "thinking" },
			{ kind: "tool", name: "bash", args: "ls" },
			{ kind: "text", text: "hello world" },
		]);
	});

	it("records each toolcall_end as its own tool event", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const starter = agent.spawnAndSend("prompt");
		fake.emitEvent({ type: "agent_settled" }); // acks spawn
		await starter;

		// Each tool call arrives as one authoritative toolcall_end (v0.84 — no
		// incremental snapshots to merge anymore); text deltas interleave.
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call_1", name: "bash", arguments: { command: "echo hi" } },
			},
		});
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				toolCall: { id: "call_2", name: "read", arguments: { path: "a.ts" } },
			},
		});
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y" } });

		assert.deepEqual(agent.getEvents(), [
			{ kind: "tool", name: "bash", args: "echo hi", id: "call_1" },
			{ kind: "text", text: "x" },
			{ kind: "tool", name: "read", args: "a.ts", id: "call_2" },
			{ kind: "text", text: "y" },
		]);
	});
});

describe("AgentProcess — persistent / in-tree messages", () => {
	it("persistent flags through to the process", () => {
		const { agent } = makeAgent({ cwd: "/tmp", persistent: true });
		assert.equal(agent.persistent, true);
		const { agent: plain } = makeAgent({ cwd: "/tmp" });
		assert.equal(plain.persistent, false);
	});

	it("sendMessage delivers a prompt with streamingBehavior steer (unified delivery)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const ok = await agent.sendMessage("[from ] focus on errors");
		assert.equal(ok, true);
		const last = fake.commands[fake.commands.length - 1];
		assert.equal(last?.type, "prompt");
		assert.equal((last as { streamingBehavior?: string })?.streamingBehavior, "steer");
		assert.equal((last as { message?: string })?.message, "[from ] focus on errors");
	});

	it("sendMessage returns false on a failed preflight", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptOk = false;
		assert.equal(await agent.sendMessage("hi"), false);
	});

	it("sendMessage wakes an idle persistent agent back to running", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done; // → completed, process kept (persistent)
		assert.equal(agent.status, "completed");
		assert.equal(await agent.sendMessage("continue"), true);
		assert.equal(agent.status, "running");
	});

	it("a woken agent streams its follow-up output (issue #30: the widget excerpt must move)", async () => {
		const deltas: string[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true, onDelta: (d) => deltas.push(d) });
		await agent.spawnAndSend("count to 3");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;

		// No deltas for the first turn: everything asserted below came from the wake.
		await agent.sendMessage("count to 5");
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "1 2 3" } });
		fake.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " 4 5" } });

		assert.deepEqual(deltas, ["1 2 3", " 4 5"], "deltas from the resumed turn must be delivered");
		assert.deepEqual(
			agent.getLatestActivity(),
			{ kind: "text", text: "1 2 3 4 5" },
			"the latest activity must update for the widget",
		);
	});

	it("a settle after wake returns the persistent agent to completed (idle)", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		await agent.sendMessage("continue");
		fake.emitSettled();
		assert.equal(agent.status, "completed");
	});

	it("completion ids are stable for one settlement and distinct across wakes/processes", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		const first = await done;
		assert.equal(first.completionId, agent.completionId);
		assert.equal((await agent.waitForCompletion()).completionId, first.completionId);
		await agent.sendMessage("a real follow-up");
		fake.emitSettled();
		assert.notEqual(agent.completionId, first.completionId);
		const other = makeAgent({ cwd: "/tmp", agentId: agent.agentId });
		assert.notEqual(other.agent.completionId, agent.completionId);
	});

	it("onIdle fires with completed when a woken persistent agent settles", async () => {
		const outcomes: string[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true, onIdle: (o) => outcomes.push(o) });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		assert.deepEqual(outcomes, [], "no onIdle before a wake");
		await agent.sendMessage("continue");
		fake.emitSettled();
		assert.deepEqual(outcomes, ["completed"], "completed on a clean follow-up settle");
	});

	it("a failed follow-up reports failed — never disguised as idle", async () => {
		const outcomes: string[] = [];
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true, onIdle: (o) => outcomes.push(o) });
		await agent.spawnAndSend("do it");
		const done = agent.waitForCompletion();
		fake.emitSettled();
		await done;
		await agent.sendMessage("continue");
		// agent_end with a model error → agentError set → the follow-up failed.
		fake.emitEvent({
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "API boom" }],
		} as never);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["failed"]);
		assert.equal(agent.status, "failed");
	});

	it("in-tree messages from the child fire onMessage", () => {
		const received: Array<{ to: string; from: string; message: string }> = [];
		const { fake } = makeAgent({ cwd: "/tmp", onMessage: (m) => received.push(m) });
		fake.emitEvent({
			type: "extension_ui_request",
			method: "setStatus",
			statusKey: "pi-subagent-msg",
			statusText: JSON.stringify({ to: "@parent", from: "a1", message: "need help" }),
		} as never);
		assert.deepEqual(received, [{ to: "@parent", from: "a1", message: "need help" }]);
	});

	it("identity env is passed to the child", () => {
		const { fake } = makeAgent({ cwd: "/tmp", env: { PI_SUBAGENT_AGENT_ID: "a1", PI_SUBAGENT_PARENT: "" } });
		assert.ok(fake.env);
		assert.equal(fake.env.PI_SUBAGENT_AGENT_ID, "a1");
	});
});

describe("AgentProcess — stop", () => {
	it("graceful stop flags stoppedByControl and ends stdin", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		await agent.stop();
		assert.equal(agent.status, "stopped");
		assert.equal(agent.stoppedByControl, true);
		assert.equal(fake.endInputCalls, 1);
	});

	it("interrupts a pending waitForCompletion with status stopped", async () => {
		const { agent } = makeAgent({ cwd: "/tmp" });
		await agent.spawnAndSend("do it");

		const completionPromise = agent.waitForCompletion();
		await agent.stop(); // endInput → fake exits → onExit releases settle

		const completion = await completionPromise;
		assert.equal(completion.status, "stopped");
	});
});

/** A persistent agent whose first turn completed (resident, idle). */
async function idleAgent(options: Partial<AgentProcessOptions> = {}) {
	const outcomes: string[] = [];
	const made = makeAgent({ cwd: "/tmp", persistent: true, onIdle: (o) => outcomes.push(o), ...options });
	await made.agent.spawnAndSend("do it");
	const done = made.agent.waitForCompletion();
	made.fake.emitSettled();
	await done;
	return { ...made, outcomes };
}

describe("AgentProcess — who is owed a turn's answer", () => {
	it("a parent message during a user side chat makes the turn owed to the parent", async () => {
		const { agent } = await idleAgent();
		await agent.sendMessage("side question", "user");
		assert.equal(agent.parentIsWaiting, false, "a user-only wake is a side chat");
		await agent.sendMessage("[from ] status?", "parent");
		assert.equal(agent.parentIsWaiting, true);
	});

	it("a user message during a parent wake does not cancel the owed answer", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.sendMessage("[from ] continue", "parent");
		await agent.sendMessage("also check X", "user");
		assert.equal(agent.parentIsWaiting, true);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["completed"]);
		assert.equal(agent.parentIsWaiting, true, "still readable when onIdle runs");
	});

	it("the next wake starts clean", async () => {
		const { agent, fake } = await idleAgent();
		await agent.sendMessage("[from ] continue", "parent");
		fake.emitSettled();
		await agent.sendMessage("side question", "user");
		assert.equal(agent.parentIsWaiting, false);
	});

	it("a completion records whether the parent started the turn (revive origin)", async () => {
		const parent = makeAgent({ cwd: "/tmp" });
		await parent.agent.spawnAndSend("do it");
		const p = parent.agent.waitForCompletion();
		parent.fake.emitSettled();
		assert.equal((await p).owedToParent, true);

		const user = makeAgent({ cwd: "/tmp" });
		await user.agent.spawnAndSend("side chat", "user");
		const u = user.agent.waitForCompletion();
		user.fake.emitSettled();
		assert.equal((await u).owedToParent, false);
	});
});

describe("AgentProcess — internal wakes", () => {
	it("reports a background-result wake with a fresh snapshot and inherited parent ownership", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		const first = await agent.completionSnapshot();
		fake.emitEvent({ type: "agent_start" });
		assert.equal(agent.status, "running");
		assert.equal(agent.parentIsWaiting, true);
		assert.notEqual(agent.completionId, first.completionId);
		fake.emitEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "background command finished" }] },
		});
		fake.emitSettled();
		const wake = await agent.completionSnapshot();
		assert.deepEqual(outcomes, ["completed"]);
		assert.equal(wake.output, "background command finished");
		assert.equal(wake.owedToParent, true);
		assert.equal((await agent.waitForCompletion()).completionId, first.completionId);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["completed"], "a repeated settlement must not report twice");
		await agent.stop();
	});

	for (const order of ["before-response", "after-response", "settled-before-response"] as const) {
		it(`keeps handled idle user commands private (${order})`, async () => {
			const { agent, fake } = await idleAgent();
			const first = await agent.completionSnapshot();
			const finish = () => {
				fake.emitEvent({
					type: "message_end",
					message: { role: "assistant", content: [{ type: "text", text: "private command answer" }] },
				});
				fake.emitSettled();
			};
			const send = fake.sendCommand.bind(fake);
			fake.promptDisposition = "handled";
			fake.sendCommand = async (command, onResponse) => {
				if (command.type === "prompt" && order !== "after-response") {
					fake.emitEvent({ type: "agent_start" });
					if (order === "settled-before-response") finish();
				}
				return send(command, onResponse);
			};
			assert.equal(await agent.sendMessage("/private-command", "user"), false);
			if (order === "after-response") fake.emitEvent({ type: "agent_start" });
			if (order !== "settled-before-response") finish();
			assert.equal((await agent.completionSnapshot()).owedToParent, false);
			assert.equal(first.owedToParent, true, "the prior completed result must not be retracted");
			fake.promptDisposition = "started";
			await agent.sendMessage("parent follow-up");
			assert.equal(agent.parentIsWaiting, true, "accepted parent input reclaims the next turn");
			fake.emitSettled();
			await agent.stop();
		});
	}

	it("an idle user command fences future autonomous work even when it starts no run itself", async () => {
		const { agent, fake } = await idleAgent();
		const first = await agent.completionSnapshot();
		fake.promptDisposition = "handled";
		await agent.sendMessage("/status", "user");
		assert.equal(agent.completionId, first.completionId);
		fake.emitEvent({ type: "agent_start" });
		fake.emitSettled();
		assert.equal((await agent.completionSnapshot()).owedToParent, false);
		await agent.stop();
	});

	it("publishes a wake transition exactly once before activity, including internal wakes", async () => {
		let wakes = 0;
		const { agent, fake } = await idleAgent({ onWake: () => wakes++ });
		fake.emitEvent({ type: "agent_start" });
		assert.equal(wakes, 1);
		fake.emitEvent({ type: "agent_start" });
		assert.equal(wakes, 1);
		fake.emitSettled();
		await agent.sendMessage("next");
		assert.equal(wakes, 2);
		fake.emitEvent({ type: "agent_start" });
		assert.equal(wakes, 2);
		fake.emitSettled();
		await agent.stop();
	});

	it("keeps user-only internal continuations private", async () => {
		const { agent, fake } = await idleAgent();
		await agent.sendMessage("side chat", "user");
		fake.emitSettled();
		const userTurn = await agent.completionSnapshot();
		fake.emitEvent({ type: "agent_start" });
		fake.emitSettled();
		const continuation = await agent.completionSnapshot();
		assert.notEqual(continuation.completionId, userTurn.completionId);
		assert.equal(continuation.owedToParent, false);
		await agent.stop();
	});

	it("does not split an active turn on retries or explicit-wake agent_start events", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.sendMessage("continue");
		const id = agent.completionId;
		fake.emitEvent({ type: "agent_start" });
		fake.emitEvent({ type: "agent_start" });
		assert.equal(agent.completionId, id);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["completed"]);
		fake.emitEvent({ type: "agent_start" });
		const internalId = agent.completionId;
		await agent.sendMessage("also check this");
		assert.equal(agent.completionId, internalId);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["completed", "completed"]);
		await agent.stop();
	});

	it("applies the wake deadline to internal continuations", async () => {
		const { agent, fake, outcomes } = await idleAgent({ timeoutMs: 10 });
		fake.emitEvent({ type: "agent_start" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.ok(fake.commands.some((command) => command.type === "abort"));
		fake.emitSettled();
		assert.deepEqual(outcomes, ["stopped"]);
		await agent.stop();
	});

	it("reports a crash during an internal continuation", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		fake.emitEvent({ type: "agent_start" });
		fake.emitExit(1);
		assert.deepEqual(outcomes, ["failed"]);
		assert.equal((await agent.completionSnapshot()).owedToParent, true);
	});
});

describe("AgentProcess — wake turns", () => {
	it("each wake restarts the turn clock", async () => {
		const { agent } = await idleAgent();
		const first = agent.turnStartedAt;
		await new Promise((r) => setTimeout(r, 5));
		await agent.sendMessage("continue");
		assert.ok(agent.turnStartedAt > first);
	});

	it("timeoutMs bounds a wake: abort, then report stopped when it settles", async () => {
		const { agent, fake, outcomes } = await idleAgent({ timeoutMs: 20, abortSettleGraceMs: 500 });
		await agent.sendMessage("continue");
		await new Promise((r) => setTimeout(r, 40));
		assert.ok(
			fake.commands.some((c) => c.type === "abort"),
			"the wake was aborted at its deadline",
		);
		fake.emitSettled();
		assert.deepEqual(outcomes, ["stopped"]);
		assert.equal(fake.endInputCalls, 0, "a settle inside the grace window avoids the hard stop");
	});

	it("a wake that never settles after the abort is hard-stopped and reported stopped", async () => {
		const { agent, fake, outcomes } = await idleAgent({ timeoutMs: 20, abortSettleGraceMs: 20 });
		await agent.sendMessage("continue");
		await new Promise((r) => setTimeout(r, 80));
		assert.deepEqual(outcomes, ["stopped"]);
		assert.equal(fake.endInputCalls, 1);
		assert.equal(agent.stoppedByControl, false, "a limit is not a deliberate stop");
		assert.equal((await agent.completionSnapshot()).stoppedByControl, false);
	});

	it("a wake that settles in time is not affected by timeoutMs", async () => {
		const { agent, fake, outcomes } = await idleAgent({ timeoutMs: 30 });
		await agent.sendMessage("continue");
		fake.emitSettled();
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(outcomes, ["completed"]);
		assert.ok(!fake.commands.some((c) => c.type === "abort"));
	});

	it("a crash in the middle of a wake reports failed", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.sendMessage("continue");
		fake.stderrText = "segfault";
		fake.emitExit(1);
		assert.deepEqual(outcomes, ["failed"]);
		assert.equal(agent.errorText, "segfault");
	});

	it("stopping a resident agent mid-wake is a deliberate stop: silent", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.sendMessage("continue");
		await agent.stop();
		assert.equal(agent.stoppedByControl, true);
		assert.equal(agent.status, "stopped");
		assert.equal(fake.endInputCalls, 1);
		assert.deepEqual(outcomes, []);
	});

	it("stopping an idle resident agent ends it without flagging a turn stop", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.stop();
		assert.equal(agent.stoppedByControl, false);
		assert.equal(fake.endInputCalls, 1);
		assert.deepEqual(outcomes, []);
	});
});

describe("AgentProcess — immutable completion snapshots", () => {
	it("binds its first wait to the spawn turn even when a wake starts during initial session lookup", {
		timeout: 1_000,
	}, async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		let releaseState!: (value: RpcResponse) => void;
		let enteredState!: () => void;
		const stateEntered = new Promise<void>((resolve) => {
			enteredState = resolve;
		});
		const send = fake.sendCommand.bind(fake);
		fake.sendCommand = async (command, onResponse) => {
			if (command.type === "get_state") {
				enteredState();
				return new Promise((resolve) => {
					releaseState = resolve;
				});
			}
			return send(command, onResponse);
		};
		const spawning = agent.spawnAndSend("first");
		await stateEntered;
		fake.lastText = "initial answer";
		fake.emitSettled();
		const firstId = agent.completionId;
		await agent.sendMessage("view wake", "user");
		assert.notEqual(agent.completionId, firstId);
		assert.equal(agent.status, "running");
		fake.lastText = "follow-up answer";
		releaseState({
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionFile: "/tmp/initial.jsonl", sessionId: "initial" },
		});
		assert.deepEqual(await spawning, { ok: true });
		const first = await agent.waitForCompletion();
		assert.equal(first.completionId, firstId);
		assert.equal(first.output, "initial answer");
		assert.equal(first.status, "completed");
		assert.equal(first.owedToParent, true);
		assert.equal(first.sessionId, "initial");
		assert.equal(agent.status, "running", "the first wait must not settle or await the follow-up");
		fake.emitSettled();
		const followUp = await agent.completionSnapshot();
		assert.notEqual(followUp.completionId, firstId);
		assert.equal(followUp.output, "follow-up answer");
		assert.equal(followUp.owedToParent, false);
		assert.strictEqual(await agent.waitForCompletion(), first, "the initial completion handle remains stable");
	});

	it("freezes the first settlement while metadata reads and a new wake overlap", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("first");
		const rows: string[] = [];
		const registry = new AgentRegistry({
			notify: () => {},
			getWidget: () => ({ add() {}, remove() {}, dispose() {}, setStatus: (_id, status) => rows.push(status) }),
		});
		registry.register(agent);
		let release!: (value: RpcResponse) => void;
		const send = fake.sendCommand.bind(fake);
		fake.sendCommand = async (command, onResponse) => {
			if (command.type === "get_session_stats")
				return new Promise((resolve) => {
					release = resolve;
				});
			return send(command, onResponse);
		};
		fake.lastText = "first answer";
		const waiting = agent.waitForCompletion();
		fake.emitSettled();
		const snapshot = agent.completionSnapshot();
		const firstId = agent.completionId;
		assert.equal(agent.status, "completed");
		await agent.sendMessage("second", "user");
		fake.lastText = "second answer";
		assert.notEqual(agent.completionId, firstId, "acceptance advances identity before the next settle");
		release({ type: "response", command: "get_session_stats", success: true, data: { tokens: { total: 42 } } });
		const completion = await waiting;
		assert.strictEqual(await snapshot, completion);
		assert.equal(completion.completionId, firstId);
		assert.equal(completion.status, "completed");
		assert.equal(completion.output, "first answer");
		assert.equal(completion.owedToParent, true);
		assert.equal(agent.parentIsWaiting, false);
		assert.equal(agent.status, "running", "old metadata reads cannot mutate the accepted wake");
		assert.equal(agent.isCurrentCompletion(completion), false);
		await registry.complete(agent, completion);
		assert.equal(registry.lookup(agent.agentId), agent);
		assert.equal(fake.endInputCalls, 0);
		assert.deepEqual(rows, [], "the old completion cannot put the new turn's row back to idle");
	});

	it("does not let a stopped later wake suppress the pending first completion", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		const notified: string[] = [];
		const registry = new AgentRegistry({
			notify: (_agent, completion) => {
				notified.push(completion.output);
			},
		});
		await agent.spawnAndSend("first");
		registry.register(agent);
		let releaseStats!: (value: RpcResponse) => void;
		let statsReads = 0;
		const send = fake.sendCommand.bind(fake);
		fake.sendCommand = async (command, onResponse) => {
			if (command.type === "get_session_stats" && statsReads++ === 0) {
				return new Promise((resolve) => {
					releaseStats = resolve;
				});
			}
			return send(command, onResponse);
		};
		fake.lastText = "first answer";
		fake.emitSettled();
		const firstPending = agent.waitForCompletion();
		await registry.deliver(agent.agentId, "second");
		await registry.stopAndRemove(agent.agentId);
		assert.equal(agent.stoppedByControl, true);
		const stoppedWake = await agent.completionSnapshot();
		assert.equal(stoppedWake.status, "stopped");
		assert.equal(stoppedWake.stoppedByControl, true);
		await registry.complete(agent, stoppedWake);
		assert.deepEqual(notified, [], "the stopped wake stays silent");
		releaseStats({ type: "response", command: "get_session_stats", success: true, data: {} });
		const first = await firstPending;
		assert.equal(first.stoppedByControl, false, "the completed first turn's control policy is immutable");
		await registry.complete(agent, first);
		assert.deepEqual(notified, ["first answer"]);
		assert.equal(registry.lookup(agent.agentId), undefined);
	});

	it("uses authoritative message_end output even if the inspection RPC sees newer text", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
		await agent.spawnAndSend("first");
		fake.emitEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "first final" }] },
		} as never);
		fake.lastText = "not this turn";
		fake.emitSettled();
		assert.equal((await agent.waitForCompletion()).output, "first final");
	});

	it("freezes a wake snapshot before invoking onIdle", async () => {
		let captured!: Promise<import("../agent-process.js").AgentCompletion>;
		const { agent, fake } = makeAgent({
			cwd: "/tmp",
			persistent: true,
			onIdle: () => {
				captured = agent.completionSnapshot();
			},
		});
		await agent.spawnAndSend("first");
		fake.emitSettled();
		await agent.waitForCompletion();
		await agent.sendMessage("second");
		fake.lastText = "second final";
		fake.emitSettled();
		await agent.sendMessage("third", "user");
		const completion = await captured;
		assert.equal(completion.output, "second final");
		assert.equal(completion.status, "completed");
		assert.equal(completion.owedToParent, true);
		assert.equal(agent.status, "running");
		assert.equal(agent.isCurrentCompletion(completion), false);
	});
});

describe("AgentProcess — prompt dispositions and crashes", () => {
	it("rejects an initial handled prompt rather than waiting for a nonexistent run", async () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		fake.promptDisposition = "handled";
		const result = await agent.spawnAndSend("/command");
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /handled without starting/);
		assert.equal(agent.status, "failed");
		assert.equal(agent.parentIsWaiting, false);
	});

	it("does not wake an idle resident or claim ownership when a prompt was handled", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		const id = agent.completionId;
		fake.promptDisposition = "handled";
		assert.equal(await agent.sendMessage("/command"), false);
		assert.equal(agent.status, "completed");
		assert.equal(agent.completionId, id);
		assert.deepEqual(outcomes, []);
	});

	it("a handled command during a user run neither settles nor claims its answer", async () => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.sendMessage("side chat", "user");
		const id = agent.completionId;
		fake.promptDisposition = "handled";
		assert.equal(await agent.sendMessage("/command", "parent"), false);
		assert.equal(agent.status, "running");
		assert.equal(agent.parentIsWaiting, false);
		assert.equal(agent.completionId, id);
		assert.deepEqual(outcomes, []);
	});

	for (const [code, signal] of [
		[null, "SIGKILL"],
		[0, null],
	] as const) {
		it(`reports premature exit (${code}, ${signal}) as failed`, async () => {
			const { agent, fake } = makeAgent({ cwd: "/tmp", persistent: true });
			await agent.spawnAndSend("first");
			const waiting = agent.waitForCompletion();
			fake.lastText = "";
			fake.emitExit(code, signal);
			const completion = await waiting;
			assert.equal(completion.status, "failed");
			if (signal) assert.match(completion.output, /SIGKILL/);
		});
	}
});

describe("AgentProcess — live assistant snapshots", () => {
	it("keeps wire indices and returns detached snapshots until message_end", () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		assert.equal(agent.getStreamingSnapshot(), undefined);
		fake.emitEvent({
			type: "message_start",
			message: { role: "assistant", content: [], stopReason: "pending" },
		} as never);
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "first" },
		} as never);
		const snapshot = agent.getStreamingSnapshot();
		assert.ok(snapshot);
		assert.deepEqual(snapshot.contentIndices, [3]);
		assert.deepEqual(snapshot.message.content, [{ type: "text", text: "first" }]);
		snapshot.message.content.length = 0;
		snapshot.contentIndices[0] = 99;
		fake.emitEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: " second" },
		} as never);
		assert.deepEqual(agent.getStreamingSnapshot()?.message.content, [{ type: "text", text: "first second" }]);
		assert.deepEqual(agent.getStreamingSnapshot()?.contentIndices, [3]);
		fake.emitEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "first second" }] },
		} as never);
		assert.equal(agent.getStreamingSnapshot(), undefined);
	});
});

describe("AgentProcess — resident stop escalation", () => {
	it("uses the same bounded shutdown for an idle resident and clears its timer", async (t) => {
		const { agent, fake } = await idleAgent();
		fake.closeOnEnd = false;
		const signals: NodeJS.Signals[] = [];
		fake.kill = ((signal: NodeJS.Signals) => {
			signals.push(signal);
			fake.emitExit(null, signal);
		}) as typeof fake.kill;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const stopping = agent.stop();
		assert.equal(fake.endInputCalls, 1);
		assert.equal(agent.status, "stopped");
		t.mock.timers.tick(5_000);
		await stopping;
		assert.deepEqual(signals, ["SIGTERM"]);
		assert.equal(agent.stoppedByControl, false);
	});

	it("escalates an unresponsive resident to SIGKILL and stays silent during explicit stop", async (t) => {
		const { agent, fake, outcomes } = await idleAgent();
		await agent.sendMessage("second");
		fake.closeOnEnd = false;
		const signals: NodeJS.Signals[] = [];
		fake.kill = ((signal: NodeJS.Signals) => {
			signals.push(signal);
			if (signal === "SIGKILL") fake.emitExit(null, signal);
		}) as typeof fake.kill;
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const stopping = agent.stop();
		t.mock.timers.tick(5_000);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		t.mock.timers.tick(5_000);
		await stopping;
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(agent.stoppedByControl, true);
		assert.deepEqual(outcomes, []);
	});
});

describe("AgentProcess — the child's footer statuses", () => {
	it("tracks its extensions' setStatus calls, ignoring the reserved in-tree keys", () => {
		const { agent, fake } = makeAgent({ cwd: "/tmp" });
		const status = (statusKey: string, statusText?: string) =>
			fake.emitEvent({ type: "extension_ui_request", method: "setStatus", statusKey, statusText } as never);
		status("web", "web: on");
		status("mcp", "mcp: 2");
		status("pi-subagent-tree", JSON.stringify({ op: "remove", id: "x", status: "done" }));
		status("mcp");
		assert.deepEqual([...agent.getStatuses()], [["web", "web: on"]]);
	});
});
