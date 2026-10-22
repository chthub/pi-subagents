import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import extension from "../index.js";
import { ROSTER_STATE_TYPE } from "../roster-state.js";

initTheme("dark");

test("agent selector keeps same-named nested entries distinct and opens the selected one", async (t) => {
	const manager = SessionManager.inMemory("/work");
	manager.appendCustomEntry(ROSTER_STATE_TYPE, {
		entries: [
			{ agentId: "max", label: "parent A", status: "done", startedAt: 0, indent: 0 },
			{ agentId: "max/sam", parentId: "max", label: "research", status: "done", startedAt: 0, indent: 1 },
			{ agentId: "zoe", label: "parent B", status: "done", startedAt: 0, indent: 0 },
			{ agentId: "zoe/sam", parentId: "zoe", label: "research", status: "done", startedAt: 0, indent: 1 },
		],
	});
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionCommandContext) => unknown)[]>();
	type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
	const commands = new Map<string, Command>();
	let options: string[] = [];
	let opened = "";
	const ui = {
		setStatus() {},
		notify() {},
		setWidget() {},
		onTerminalInput: () => () => {},
		select: async (_title: string, items: string[]) => {
			options = items;
			return items[3];
		},
		custom: async (factory: (...args: never[]) => Component & { dispose(): void }) => {
			const view = factory(
				{ terminal: { rows: 40 }, requestRender() {} } as never,
				{ fg: (_key: string, text: string) => text, bold: (text: string) => text } as never,
				new KeybindingsManager(TUI_KEYBINDINGS) as never,
				(() => {}) as never,
			);
			opened = stripTerminalSequences(view.render(120)[0]);
			view.dispose();
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/work",
		isIdle: () => true,
		sessionManager: manager,
		ui,
	} as unknown as ExtensionCommandContext;
	extension({
		on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) => {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
			return () => {};
		},
		registerTool() {},
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		sendMessage() {},
	} as unknown as ExtensionAPI);
	const fire = async (name: string) => {
		for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
	};
	t.after(() => fire("session_shutdown"));
	await fire("session_start");
	const command = commands.get("agents");
	assert.ok(command);
	await command.handler("", ctx);
	assert.equal(new Set(options).size, options.length);
	assert.match(options[1], /via @max/);
	assert.match(options[3], /via @zoe/);
	assert.match(opened, /@zoe\/sam/);
});
