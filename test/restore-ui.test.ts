import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import extension from "../index.js";
import { ROSTER_STATE_TYPE } from "../roster-state.js";

function setup() {
	const manager = SessionManager.inMemory("/work");
	const handlers = new Map<string, ((event: never, context: never) => unknown)[]>();
	let component: Component | undefined;
	let registrations = 0;
	const ctx = {
		mode: "tui",
		cwd: "/work",
		sessionManager: manager,
		ui: {
			notify() {},
			onTerminalInput: () => () => {},
			setWidget: (_key: string, content: unknown) => {
				component = undefined;
				if (typeof content !== "function") return;
				registrations++;
				component = (content as (tui: unknown, theme: unknown) => Component)(
					{ requestRender() {} },
					{ fg: (_color: string, text: string) => text },
				);
			},
		},
	};
	extension({
		on: (event: string, callback: (event: never, context: never) => unknown) => {
			const listeners = handlers.get(event) ?? [];
			listeners.push(callback);
			handlers.set(event, listeners);
			return () => {};
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools() {},
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
	} as never);
	return {
		manager,
		fire: async (name: string, event: unknown = {}) => {
			for (const handler of handlers.get(name) ?? []) await handler(event as never, ctx as never);
		},
		clearUI: () => {
			component = undefined;
		},
		text: () => component?.render(120).join("\n") ?? "",
		registrations: () => registrations,
	};
}

test("session_start restores the bottom widget after compaction, UI reset and reload", async (t) => {
	const host = setup();
	t.after(() => host.fire("session_shutdown", { reason: "quit" }));
	host.manager.appendMessage({
		role: "toolResult",
		toolName: "agent_spawn",
		toolCallId: "call",
		isError: false,
		timestamp: 1000,
		content: [],
		details: { agentId: "max", label: "check", sessionPath: "/s/max.jsonl" },
	} as never);
	const keep = host.manager.appendMessage({ role: "user", content: "continue", timestamp: 2000 });
	host.manager.appendCompaction("summary", keep, 10000);
	await host.fire("session_start");
	assert.match(host.text(), /@max/);
	host.clearUI();
	await host.fire("session_shutdown", { reason: "reload" });
	assert.equal(host.text(), "");
	await host.fire("session_start");
	assert.match(host.text(), /@max/);
	assert.equal(host.registrations(), 2);
});

test("restarting the session binding re-registers cached widget state on the new UI", async (t) => {
	const host = setup();
	t.after(() => host.fire("session_shutdown", { reason: "quit" }));
	host.manager.appendCustomEntry(ROSTER_STATE_TYPE, {
		entries: [
			{
				agentId: "zoe",
				label: "nested spawn",
				status: "running",
				startedAt: 1000,
				indent: 0,
				sessionPath: "/s/zoe.jsonl",
			},
		],
	});
	await host.fire("session_start");
	assert.match(host.text(), /@zoe/);
	assert.match(host.text(), /stopped/);
	host.clearUI();
	await host.fire("session_start");
	assert.match(host.text(), /@zoe/);
	assert.equal(host.registrations(), 2);
});
