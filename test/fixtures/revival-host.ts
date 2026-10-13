import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../../index.js";
import { ROSTER_STATE_TYPE } from "../../roster-state.js";

const tools = new Map<string, ToolDefinition>();
const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
const notices: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
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
	sendMessage(notice: Parameters<ExtensionAPI["sendMessage"]>[0]) {
		notices.push(notice);
		manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display ?? true, notice.details);
	},
} as unknown as ExtensionAPI);
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
const send = tools.get("agent_send");
if (!send) throw new Error("agent_send must be registered");
try {
	const deliver = (message: string) => send.execute(message, { to: "max", message }, undefined, undefined, ctx);
	const results = [];
	if (process.env.REVIVAL_TEST_MODE === "idle-exit") {
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
	process.stdout.write(JSON.stringify(results));
} finally {
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
}
