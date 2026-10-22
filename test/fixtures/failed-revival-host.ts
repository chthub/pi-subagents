import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	initTheme,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { AgentView } from "../../agent-view.js";
import { CHILD_LAUNCH_EVENT, type ChildLaunch } from "../../child-launch.js";
import extension from "../../index.js";
import { ROSTER_STATE_TYPE } from "../../roster-state.js";

initTheme("dark");
const mode = process.env.FAILED_REVIVAL_MODE as string;
const logPath = process.env.FAILED_REVIVAL_LOG as string;
const releasePath = process.env.FAILED_REVIVAL_RELEASE as string;
const resumeReleasePath = process.env.FAILED_REVIVAL_RESUME_RELEASE as string;
const replacementReleasePath = process.env.FAILED_REVIVAL_REPLACEMENT_RELEASE as string;
const sessionPath = process.env.FAILED_REVIVAL_SESSION as string;
type RecordEntry = { kind: string; pid: number; account: string; message?: string; text?: string; args?: string[] };
const records = (): RecordEntry[] =>
	readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const waitUntil = async (ready: () => boolean, reason: string) => {
	const deadline = Date.now() + 5000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${reason}; ${JSON.stringify(records())}`);
		await delay(5);
	}
};
const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const release = () => writeFileSync(releasePath, "release");
const tools = new Map<string, ToolDefinition>();
const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
const commands = new Map<string, Command>();
const notices: { status: string; result: string }[] = [];
const manager = SessionManager.inMemory(process.cwd());
writeFileSync(
	sessionPath,
	`${JSON.stringify({ type: "session", version: 3, id: "saved", timestamp: new Date(0).toISOString(), cwd: process.cwd() })}\n`,
);
manager.appendCustomEntry(ROSTER_STATE_TYPE, {
	entries: [
		{
			agentId: "max",
			label: "quota regression",
			status: "done",
			startedAt: 0,
			indent: 0,
			sessionPath,
			cwd: process.cwd(),
		},
	],
});
let account = "account-a";
const hooks: string[] = [];
const events = createEventBus();
events.on(CHILD_LAUNCH_EVENT, (data) => {
	const launch = data as ChildLaunch;
	hooks.push(account);
	appendFileSync(logPath, `${JSON.stringify({ kind: "hook", pid: process.pid, account })}\n`);
	launch.env.SYNTHETIC_ACCOUNT = account;
	launch.extensions.push(`/example/${account}.ts`);
});
let view: AgentView | undefined;
let closeView: (() => void) | undefined;
const ui = {
	setStatus() {},
	notify() {},
	setWidget() {},
	onTerminalInput: () => () => {},
	custom: async (factory: (...args: never[]) => AgentView) => {
		await new Promise<void>((resolve) => {
			closeView = resolve;
			view = factory(
				{ terminal: { rows: 40 }, requestRender() {} } as never,
				{ fg: (_key: string, text: string) => text, bold: (text: string) => text } as never,
				new KeybindingsManager(TUI_KEYBINDINGS) as never,
				resolve as never,
			);
		});
	},
};
const ctx = {
	mode: "rpc",
	cwd: process.cwd(),
	isIdle: () => true,
	sessionManager: manager,
	ui,
	modelRegistry: { getAvailable: () => [], find: () => undefined },
} as unknown as Parameters<ToolDefinition["execute"]>[4];
const fire = async (name: string) => {
	for (const handler of handlers.get(name) ?? []) await handler({ aborted: false, reason: "quit" }, ctx);
};
extension({
	events,
	on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
		const current = handlers.get(name) ?? [];
		current.push(handler);
		handlers.set(name, current);
		return () => {};
	},
	registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	registerCommand: (name: string, command: Command) => commands.set(name, command),
	registerMessageRenderer() {},
	registerToolRenderer() {},
	getActiveTools: () => [],
	getAllTools: () => [],
	getThinkingLevel: () => "off",
	appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
	sendMessage(notice: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) {
		manager.appendCustomMessageEntry(notice.customType, notice.content, notice.display ?? true, notice.details);
		if (notice.customType === "subagent-notification") notices.push(JSON.parse(String(notice.content)));
		// Consume the real inbox wake without an LLM so later notifications can flow.
		if (options?.triggerTurn) setImmediate(() => void fire("agent_settled"));
	},
} as unknown as ExtensionAPI);
const execute = async (name: string, params: Record<string, unknown>) => {
	const tool = tools.get(name);
	assert.ok(tool);
	try {
		const result = await tool.execute("call", params, undefined, undefined, ctx);
		return {
			isError: result.isError === true,
			text: result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
		};
	} catch (error) {
		return { isError: true, text: (error as Error).message };
	}
};
const send = (message: string) => execute("agent_send", { to: "max", message });
const viewText = () => stripTerminalSequences(view?.render(110).join("\n") ?? "");
const submitView = (message: string) => {
	assert.ok(view);
	view.handleInput(message);
	view.handleInput("\r");
};
const waitView = async () => {
	await waitUntil(() => !/Sending…|Reviving…/.test(viewText()), "view send acknowledgement");
	return {
		isError:
			/Delivery failed|stopped while|ended while|before.*delivered|recovery was cancelled|preflight rejected/i.test(
				viewText(),
			),
		text: viewText(),
	};
};
const latestStatus = () => {
	const entry = manager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === ROSTER_STATE_TYPE)
		.at(-1);
	return entry?.type === "custom"
		? (entry.data as { entries: { agentId: string; status: string }[] }).entries.find((row) => row.agentId === "max")
				?.status
		: undefined;
};
let shutdown = false;
const results: { isError: boolean; text: string }[] = [];
try {
	await fire("session_start");
	results.push(await send("old request"));
	assert.equal(results[0].isError, false);
	const agents = commands.get("agents");
	assert.ok(agents);
	await agents.handler("max", { ...ctx, mode: "tui", hasUI: true } as unknown as ExtensionCommandContext);
	assert.ok(view);
	const initial = records().find((entry) => entry.kind === "launch");
	assert.ok(initial);
	if (mode.startsWith("healthy-idle") || mode.startsWith("ambiguous")) {
		await waitUntil(() => latestStatus() === "idle", "original resident idle");
	} else if (!mode.startsWith("healthy-running") && !mode.startsWith("stopped")) {
		process.kill(initial.pid, "SIGUSR2");
		await waitUntil(
			() => records().some((entry) => entry.kind === "stats-held") && viewText().includes("synthetic quota exhausted"),
			"failed live child with pending completion",
		);
		process.kill(initial.pid, 0);
		assert.ok(!records().some((entry) => entry.kind === "closing"));
	}
	account = "account-b";
	let priorStop: Promise<{ isError: boolean; text: string }> | undefined;
	if (mode.startsWith("stopped")) {
		priorStop = execute("agent_stop", { agent_id: "max" });
		await waitUntil(() => records().some((entry) => entry.kind === "closing"), "explicit stop began before new send");
	}
	const reportToParent = mode.endsWith("continue");
	const isView = mode.endsWith("view") || reportToParent;
	const message = mode.startsWith("ambiguous") ? "ambiguous request" : "new request";
	if (isView) submitView(reportToParent ? `/continue ${message}` : message);
	const pending = isView ? waitView() : send(message);
	if (mode.startsWith("rejected-replacement")) {
		release();
		await waitUntil(
			() => records().some((entry) => entry.kind === "closing" && entry.account === "account-b"),
			"rejected replacement cleanup began",
		);
		let shutdownDone = false;
		const shuttingDown = fire("session_shutdown").then(() => {
			shutdownDone = true;
		});
		shutdown = true;
		await flush();
		assert.equal(shutdownDone, false, "shutdown must still own and await the rejected replacement");
		writeFileSync(replacementReleasePath, "release");
		await shuttingDown;
		results.push(await pending);
		for (const entry of records().filter((entry) => entry.kind === "launch")) {
			assert.throws(() => process.kill(entry.pid, 0), "shutdown leaves no live child behind");
		}
	} else if (mode.startsWith("cancel-") || mode.startsWith("concurrent")) {
		await waitUntil(
			() => records().some((entry) => entry.kind === "closing"),
			"asynchronous replacement cleanup began",
		);
		if (mode.startsWith("concurrent-resume")) {
			release();
			await waitUntil(
				() => records().some((entry) => entry.kind === "preflight-held"),
				"replacement resume preflight pending",
			);
		}
		const second = send("second new request");
		if (mode.startsWith("cancel-")) {
			const cancellation = mode.startsWith("cancel-stop")
				? execute("agent_stop", { agent_id: "max" })
				: fire("session_shutdown");
			shutdown = mode.startsWith("cancel-shutdown");
			await flush();
			assert.equal(records().filter((entry) => entry.kind === "launch").length, 1);
			release();
			await cancellation;
			results.push(await pending, await second);
		} else {
			const third = send("third new request");
			release();
			writeFileSync(resumeReleasePath, "release");
			results.push(...(await Promise.all([pending, second, third])));
			await waitUntil(
				() => records().filter((entry) => entry.kind === "prompt").length === 4,
				"all concurrent messages delivered exactly once",
			);
		}
	} else {
		release();
		results.push(await pending);
		if (priorStop) results.push(await priorStop);
		if (mode.startsWith("quota-again")) {
			await waitUntil(
				() => records().some((entry) => entry.kind === "exit" && entry.account === "account-b"),
				"replacement quota failure cleaned up",
			);
			await delay(50);
		} else if (!mode.startsWith("healthy-running") && !mode.startsWith("ambiguous")) {
			await waitUntil(() => latestStatus() === "idle", "replacement/healthy follow-up becomes idle");
			await flush();
			if (isView && !reportToParent)
				assert.ok(
					!notices.some((notice) => notice.result === "reply:new request"),
					"a user-only turn must stay private",
				);
			else
				await waitUntil(
					() => notices.some((notice) => notice.result === "reply:new request"),
					"parent follow-up notification",
				);
			results.push(await send("parent follow-up"));
			await waitUntil(
				() => notices.some((notice) => notice.result === "reply:parent follow-up"),
				"later parent notification on same replacement",
			);
		}
	}
	await flush();
	assert.doesNotMatch(JSON.stringify(manager.getBranch()), /SYNTHETIC_ACCOUNT|account-[ab]\.ts/);
	process.stdout.write(JSON.stringify({ mode, sessionPath, results, hooks, notices, records: records() }));
} finally {
	release();
	writeFileSync(resumeReleasePath, "release");
	writeFileSync(replacementReleasePath, "release");
	view?.dispose();
	closeView?.();
	if (!shutdown) await fire("session_shutdown");
	// A fixture assertion must not leave child processes behind.
	for (const entry of records().filter((entry) => entry.kind === "launch")) {
		try {
			process.kill(entry.pid, "SIGKILL");
		} catch {
			/* already exited */
		}
	}
}
