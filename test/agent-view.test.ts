import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AgentView } from "../agent-view.js";
import type { RpcEvent } from "../protocol.js";

initTheme("dark");

function message(
	content: AssistantMessage["content"] = [],
	stopReason: AssistantMessage["stopReason"] = "pending",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function setup(loadMessages: () => Promise<unknown[]> = async () => []) {
	let listener: ((event: RpcEvent) => void) | undefined;
	const view = new AgentView(
		{ terminal: { rows: 40 }, requestRender() {} } as never,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
		{ matches: () => false } as never,
		{
			agentId: "test",
			cwd: process.cwd(),
			entry: () => undefined,
			processKey: () => "process",
			subscribe: (callback) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			loadMessages,
			send: async () => undefined,
			onRosterChange: () => () => {},
			renderers: () => undefined,
		},
		() => {},
	);
	return {
		view,
		emit: (event: RpcEvent) => {
			assert.ok(listener);
			listener(event);
		},
		update: (event: unknown) => {
			assert.ok(listener);
			listener({ type: "message_update", assistantMessageEvent: event });
		},
		text: () => view.render(120).join("\n"),
	};
}

test("the conversation viewport has a right-hand scrollbar that follows scrolling", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const rail = () =>
		view
			.render(120)
			.slice(3, -4)
			.map((line) => stripTerminalSequences(line).at(-1));
	const bottom = rail();
	assert.ok(bottom.includes("│") && bottom.includes("┃"));
	assert.equal(bottom.at(-1), "┃", "following the end places the thumb at the bottom");
	view.handleMouse({ type: "wheel", wheelDelta: -1000 });
	const top = rail();
	assert.equal(top[0], "┃", "scrolling to the beginning moves the thumb to the top");
	assert.equal(top.at(-1), "│");
	assert.notDeepEqual(top, bottom);
	for (const width of [1, 10, 30, 120]) {
		assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("short content shows a full scrollbar thumb without an invalid position", async (t) => {
	const { view } = setup();
	t.after(() => view.dispose());
	await Promise.resolve();
	const lines = view.render(120).map(stripTerminalSequences);
	assert.ok(lines.slice(3, -4).every((line) => line.endsWith("┃")));
	assert.doesNotMatch(lines.at(-1) ?? "", /\d+–\d+\/\d+/);
});

test("tool followed by streamed text renders and scrolls without crashing", async (t) => {
	const { view, emit, update, text } = setup();
	t.after(() => view.dispose());
	await Promise.resolve();
	emit({ type: "message_start", message: message() });
	update({ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "read" });
	update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"x"}' });
	update({
		type: "toolcall_end",
		contentIndex: 0,
		toolCall: { type: "toolCall", id: "call", name: "read", arguments: { path: "x" } },
	});
	assert.doesNotThrow(() => update({ type: "text_delta", contentIndex: 1, delta: "after tool" }));
	assert.match(text(), /after tool/);
	view.handleMouse({ type: "wheel", wheelDelta: -3 });
	assert.doesNotThrow(text);
});

test("thinking/tool/text content gaps do not crash rendering", async (t) => {
	const { view, emit, update, text } = setup();
	t.after(() => view.dispose());
	await Promise.resolve();
	emit({ type: "message_start", message: message() });
	update({ type: "thinking_delta", contentIndex: 0, delta: "reasoning" });
	update({ type: "toolcall_start", contentIndex: 1, id: "call", toolName: "read" });
	assert.doesNotThrow(() => update({ type: "text_delta", contentIndex: 2, delta: "answer" }));
	assert.match(text(), /reasoning/);
	assert.match(text(), /answer/);
	// A missing or empty preceding block must not become a sparse renderer array.
	assert.doesNotThrow(() => update({ type: "text_delta", contentIndex: 5, delta: "later" }));
	assert.match(text(), /later/);
});

test("message_end replaces partial content immediately", async (t) => {
	const { view, emit, update, text } = setup();
	t.after(() => view.dispose());
	await Promise.resolve();
	emit({ type: "message_start", message: message() });
	update({ type: "text_delta", contentIndex: 0, delta: "draft" });
	emit({ type: "message_end", message: message([{ type: "text", text: "authoritative final" }], "stop") });
	assert.match(text(), /authoritative final/);
	assert.doesNotMatch(text(), /draft/);
});

test("an earlier transcript reload cannot erase a newer live message", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let finishReload!: (messages: unknown[]) => void;
	let calls = 0;
	const { view, emit, update, text } = setup(() => {
		if (++calls === 1) return Promise.resolve([]);
		return new Promise((resolve) => {
			finishReload = resolve;
		});
	});
	t.after(() => view.dispose());
	await Promise.resolve();
	emit({ type: "message_start", message: message() });
	emit({ type: "message_end", message: message([], "stop") });
	t.mock.timers.tick(60);
	assert.equal(calls, 2);
	emit({ type: "message_start", message: message() });
	update({ type: "text_delta", contentIndex: 0, delta: "new turn" });
	finishReload([]);
	await Promise.resolve();
	await Promise.resolve();
	assert.match(text(), /new turn/);
});

test("a reload begun before message_end cannot clear its authoritative final content", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let finishReload!: (messages: unknown[]) => void;
	let calls = 0;
	const { view, emit, text } = setup(() => {
		if (++calls === 1) return Promise.resolve([]);
		return new Promise((resolve) => {
			finishReload = resolve;
		});
	});
	t.after(() => view.dispose());
	await Promise.resolve();
	emit({ type: "message_start", message: message() });
	emit({ type: "tool_execution_end" });
	t.mock.timers.tick(60);
	emit({ type: "message_end", message: message([{ type: "text", text: "final after reload started" }], "stop") });
	finishReload([]);
	await Promise.resolve();
	await Promise.resolve();
	assert.match(text(), /final after reload started/);
});

test("tool result reloads leave an unfinished assistant stream intact", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { view, emit, update, text } = setup();
	t.after(() => view.dispose());
	await Promise.resolve();
	emit({ type: "message_start", message: message() });
	update({ type: "text_delta", contentIndex: 0, delta: "still streaming" });
	emit({ type: "tool_execution_end" });
	t.mock.timers.tick(60);
	await Promise.resolve();
	await Promise.resolve();
	assert.match(text(), /still streaming/);
});
