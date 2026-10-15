import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { CHILD_LAUNCH_EVENT, type ChildLaunch } from "../../child-launch.js";
import extension from "../../index.js";
import { ROSTER_STATE_TYPE } from "../../roster-state.js";

const tools = new Map<string, ToolDefinition>();
const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
const notices: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
const events = createEventBus();
const launchLog = process.env.REVIVAL_TEST_LAUNCH_LOG as string;
if (process.env.REVIVAL_TEST_HOOK !== "none") {
	events.on(CHILD_LAUNCH_EVENT, (data) => {
		const launch = data as ChildLaunch;
		appendFileSync(launchLog, `${JSON.stringify({ kind: "hook", initial: launch })}\n`);
		if (process.env.REVIVAL_TEST_HOOK === "error") {
			try {
				throw new Error("private detail");
			} catch {
				launch.error = "Integration unavailable";
			}
		} else if (process.env.REVIVAL_TEST_HOOK === "malformed-error") {
			Object.assign(launch, { error: 42 });
		} else if (process.env.REVIVAL_TEST_HOOK === "invalid") {
			Object.assign(launch.env, { INVALID: 42 });
		} else {
			launch.env.LAUNCH_ONLY = "launch-only-value";
			launch.env.PI_SUBAGENT_AGENT_ID = "spoof";
			launch.env.PI_SUBAGENT_DEPTH = "99";
			launch.env.PI_SUBAGENT_MAX_DEPTH = "99";
			launch.extensions.push("/example/launch-only-extension.ts", "/example/launch-only-extension.ts");
		}
	});
}
const manager = SessionManager.inMemory(process.cwd());
manager.appendCustomEntry(ROSTER_STATE_TYPE, {
	entries: [
		{
			agentId: "max",
			label: "resume test",
			status: "done",
			startedAt: 1000,
			indent: 0,
			sessionPath: `${process.cwd()}/saved.jsonl`,
			cwd: process.cwd(),
		},
	],
});
const ctx = {
	mode: "rpc",
	cwd: process.cwd(),
	isIdle: () => true,
	sessionManager: manager,
	ui: { setStatus() {}, notify() {} },
} as unknown as Parameters<ToolDefinition["execute"]>[4];
extension({
	events,
	getThinkingLevel: () => "off",
	on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
		const current = handlers.get(name) ?? [];
		current.push(handler);
		handlers.set(name, current);
		return () => {};
	},
	registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	registerCommand() {},
	registerMessageRenderer() {},
	registerToolRenderer() {},
	getActiveTools: () => [],
	getAllTools: () => [],
	appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
	sendMessage(notice: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) {
		notices.push(notice);
		manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display ?? true, notice.details);
		if (options?.triggerTurn && process.env.REVIVAL_TEST_MODE?.startsWith("internal-")) {
			// The token-free parent consumes the notification and settles. Without
			// this lifecycle event the real inbox correctly keeps later results queued.
			setImmediate(() => {
				for (const handler of handlers.get("agent_settled") ?? []) void handler({ aborted: false }, ctx);
			});
		}
	},
} as unknown as ExtensionAPI);
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
const send = tools.get("agent_send");
if (!send) throw new Error("agent_send must be registered");
try {
	const execute = async (tool: ToolDefinition, params: Record<string, unknown>) => {
		try {
			return await tool.execute("call", params, undefined, undefined, ctx);
		} catch (error) {
			return { isError: true, content: [{ type: "text", text: (error as Error).message }] };
		}
	};
	const deliver = (message: string) => execute(send, { to: "max", message });
	const results = [];
	if (process.env.REVIVAL_TEST_MODE?.startsWith("internal-")) {
		const statusHistory: string[] = [];
		const seen = new Set<string>();
		// appendEntry is the persisted roster boundary used by the real UI.
		const deadline = Date.now() + 5000;
		const observe = () => {
			for (const entry of manager.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== ROSTER_STATE_TYPE || seen.has(entry.id)) continue;
				seen.add(entry.id);
				const rows = (entry.data as { entries: { status: string }[] }).entries;
				const status = rows.at(-1)?.status;
				if (status && status !== statusHistory.at(-1)) statusHistory.push(status);
			}
		};
		if (process.env.REVIVAL_TEST_MODE === "internal-spawn") {
			const spawn = tools.get("agent_spawn");
			if (!spawn) throw new Error("agent_spawn must be registered");
			results.push(await execute(spawn, { prompt: "first", label: "background test", run_in_background: true }));
		} else {
			results.push(await deliver("first"));
		}
		while (notices.filter((notice) => notice.customType === "subagent-notification").length < 2) {
			observe();
			if (Date.now() >= deadline) throw new Error("Timed out waiting for internal wake notification");
			await delay(5);
		}
		observe();
		const replies = notices
			.filter((notice) => notice.customType === "subagent-notification")
			.map((notice) => JSON.parse(String(notice.content)));
		assert.deepEqual(
			replies.map((reply) => reply.result),
			["initial reply", "background reply"],
		);
		assert.notEqual(replies[0].completion_id, replies[1].completion_id);
		assert.ok(statusHistory.join(",").includes("idle,running,idle"), JSON.stringify(statusHistory));
	} else if (process.env.REVIVAL_TEST_MODE === "spawn") {
		const spawn = tools.get("agent_spawn");
		if (!spawn) throw new Error("agent_spawn must be registered");
		results.push(await execute(spawn, { prompt: "first", label: "launch test", run_in_background: true }));
	} else if (process.env.REVIVAL_TEST_MODE === "idle-exit") {
		const waitUntil = async (ready: () => boolean) => {
			const deadline = Date.now() + 3000;
			while (!ready()) {
				if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle callback");
				await delay(5);
			}
		};
		results.push(await deliver("first"));
		await waitUntil(() => notices.some((notice) => notice.customType === "subagent-notification"));
		const first = JSON.parse(
			readFileSync(process.env.REVIVAL_TEST_LOG as string, "utf8")
				.trim()
				.split("\n")[0],
		);
		process.kill(first.pid, "SIGKILL");
		await waitUntil(() => {
			const saved = manager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === ROSTER_STATE_TYPE)
				.at(-1);
			return (
				saved?.type === "custom" &&
				(saved.data as { entries: { agentId: string; status: string }[] }).entries.some(
					(entry) => entry.agentId === "max" && entry.status === "done",
				)
			);
		});
		results.push(await deliver("second"));
	} else {
		results.push(...(await Promise.all(["first", "second", "third"].map(deliver))));
	}
	assert.doesNotMatch(JSON.stringify(manager.getBranch()), /launch-only-value|launch-only-extension/);
	process.stdout.write(JSON.stringify(results));
} finally {
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
}
