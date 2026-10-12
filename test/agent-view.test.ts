import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { AgentView, type AgentViewDeps } from "../agent-view.js";
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

function mouse(type: TuiMouseEvent["type"], fields: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 119,
		y: 3,
		screenX: 119,
		screenY: 3,
		width: 120,
		height: 40,
		shift: false,
		alt: false,
		ctrl: false,
		...fields,
	};
}

function rail(view: AgentView, width = 120) {
	const lines = view.render(width).map(stripTerminalSequences);
	const rows = lines.map((text, y) => ({ text, y })).filter(({ text }) => /[│┃█]$/.test(text));
	const thumb = rows.filter(({ text }) => /[┃█]$/.test(text));
	return {
		x: width - 1,
		y: rows[0]?.y ?? 0,
		height: rows.length,
		thumbY: thumb[0]?.y ?? 0,
		thumbHeight: thumb.length,
		/** The visible conversation rows (rail glyph removed): where the view is scrolled to. */
		content: rows.map(({ text }) => text.slice(0, -1)).join("\n"),
	};
}

function setup(
	loadMessages: () => Promise<unknown[]> = async () => [],
	extra: Partial<Pick<AgentViewDeps, "canStop" | "stop" | "footer">> = {},
) {
	let listener: ((event: RpcEvent) => void) | undefined;
	const terminal = { rows: 40 };
	const view = new AgentView(
		{ terminal, requestRender() {} } as never,
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
			...extra,
			onRosterChange: () => () => {},
			renderers: () => undefined,
		},
		() => {},
	);
	return {
		view,
		terminal,
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
	view.handleMouse(mouse("wheel", { x: 0, wheelDelta: -1000 }));
	const top = rail();
	assert.equal(top[0], "┃", "scrolling to the beginning moves the thumb to the top");
	assert.equal(top.at(-1), "│");
	assert.notDeepEqual(top, bottom);
	for (const width of [1, 10, 30, 120]) {
		assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("thumb capture drags outside the rail, clamps at both ends, and releases", async (t) => {
	const content = Array.from({ length: 160 }, (_, i) => `line ${i}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const bottom = rail(view);
	assert.ok(bottom.thumbHeight > 1);
	const capture = view.handleMouse(
		mouse("press", {
			y: bottom.thumbY + 1,
			screenX: 129,
			screenY: bottom.thumbY + 6,
		}),
	);
	assert.equal(capture?.capture, true);
	assert.equal(rail(view).content, bottom.content, "grabbing inside the thumb must not jump");
	// Captured events remain component-local even beyond the original bounds.
	view.handleMouse(mouse("drag", { x: 5, y: -105, screenX: 15, screenY: -100 }));
	assert.equal(rail(view).thumbY, bottom.y, "dragging above the viewport clamps to the top");
	view.handleMouse(mouse("drag", { x: 240, y: 195, screenX: 250, screenY: 200 }));
	assert.equal(rail(view).content, bottom.content, "dragging below the viewport returns to the bottom");
	view.handleMouse(mouse("release", { button: "none", x: 0, y: 0 }));
	view.handleMouse(mouse("drag", { x: 0, y: -100 }));
	view.handleMouse(mouse("click", { y: bottom.y }));
	assert.equal(rail(view).content, bottom.content, "release and synthetic click must not restart the drag");
});

test("track press jumps toward the pointer and subsequent drags preserve the grab offset", async (t) => {
	const content = Array.from({ length: 160 }, (_, i) => `line ${i}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const bottom = rail(view);
	const pointerY = bottom.y + Math.floor(bottom.height / 2);
	assert.equal(view.handleMouse(mouse("press", { y: pointerY, screenY: pointerY + 50, screenX: 129 })).capture, true);
	const middle = rail(view);
	assert.equal(middle.thumbY, pointerY - Math.floor(middle.thumbHeight / 2));
	assert.notEqual(middle.content, bottom.content);
	view.handleMouse(mouse("drag", { y: pointerY - 2, x: 110 }));
	assert.equal(rail(view).thumbY, middle.thumbY - 2);
});

test("body/header/editor presses and non-primary clicks do not grab the scrollbar", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const initial = rail(view);
	for (const fields of [{ x: 118 }, { y: 0 }, { y: initial.y + initial.height }, { button: "right" as const }]) {
		assert.notEqual(view.handleMouse(mouse("press", fields)).capture, true);
		view.handleMouse(mouse("drag", { y: -100 }));
		assert.equal(rail(view).content, initial.content);
	}
});

test("resize, loss of focus and disappearance of the rail cancel active drags", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const { view, terminal } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	view.focused = true;
	let geometry = rail(view);
	view.handleMouse(mouse("press", { y: geometry.thumbY }));
	terminal.rows = 25;
	const resized = rail(view, 80);
	view.handleMouse(mouse("drag", { y: -100 }));
	assert.equal(rail(view, 80).content, resized.content);
	geometry = rail(view);
	view.handleMouse(mouse("press", { y: geometry.thumbY }));
	view.focused = false;
	view.handleMouse(mouse("drag", { y: -100 }));
	assert.equal(rail(view).content, geometry.content);
	view.handleMouse(mouse("press", { y: geometry.thumbY }));
	view.render(1);
	assert.notEqual(view.handleMouse(mouse("press", { x: 0 })).capture, true);
	view.handleMouse(mouse("drag", { y: -100 }));
	assert.equal(rail(view).content, geometry.content);
});

test("dragging to the bottom resumes following streamed output", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const { view, emit, update } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const initial = rail(view);
	view.handleMouse(mouse("press", { y: initial.y }));
	view.handleMouse(mouse("drag", { y: 1000 }));
	view.handleMouse(mouse("release"));
	emit({ type: "message_start", message: message() });
	update({ type: "text_delta", contentIndex: 0, delta: "new output\n".repeat(40) });
	const after = rail(view);
	assert.equal(after.thumbY + after.thumbHeight, after.y + after.height);
	assert.match(after.content.trimEnd().split("\n").at(-1) ?? "", /new output/, "viewport ends at the latest line");
});

test("hover widens the thumb without rewrapping content or changing its position", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i} \u4e2d\u6587 ${"long text ".repeat(20)}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const initial = view.render(120).map(stripTerminalSequences);
	const geometry = rail(view);
	assert.equal(view.handleMouse(mouse("move", { button: "none", y: geometry.y })).render, true);
	const hovered = view.render(120).map(stripTerminalSequences);
	assert.ok(hovered.some((line) => line.endsWith("█")));
	assert.deepEqual(
		hovered.map((line) => line.replace(/█$/, "┃")),
		initial,
	);
	assert.equal(rail(view).thumbY, geometry.thumbY);
	assert.equal(rail(view).content, geometry.content);
	assert.equal(
		view.handleMouse(mouse("move", { button: "none", y: geometry.thumbY })).render,
		false,
		"moving within the rail does not need a hover repaint",
	);
	assert.equal(view.handleMouse(mouse("move", { button: "none", x: 118 })).render, true);
	assert.deepEqual(view.render(120).map(stripTerminalSequences), initial);
});

test("drag stays wide outside the rail and release restores hover-dependent width", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	const geometry = rail(view);
	view.handleMouse(mouse("press", { y: geometry.thumbY }));
	assert.ok(view.render(120).some((line) => stripTerminalSequences(line).endsWith("█")));
	view.handleMouse(mouse("drag", { x: 0, y: -100 }));
	assert.ok(view.render(120).some((line) => stripTerminalSequences(line).endsWith("█")));
	assert.equal(view.handleMouse(mouse("release", { x: 0, y: -100 })).render, true);
	assert.ok(!view.render(120).some((line) => stripTerminalSequences(line).endsWith("█")));
	view.handleMouse(mouse("press", { y: geometry.y }));
	view.handleMouse(mouse("release", { y: geometry.y }));
	assert.ok(
		view.render(120).some((line) => stripTerminalSequences(line).endsWith("█")),
		"release on the rail keeps it wide until the pointer leaves",
	);
	view.handleMouse(mouse("move", { button: "none", y: geometry.y - 1 }));
	assert.ok(!view.render(120).some((line) => stripTerminalSequences(line).endsWith("█")));
});

test("resize and loss of focus reset hover, and narrow views stay within their width", async (t) => {
	const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const { view } = setup(async () => [message([{ type: "text", text: content }], "stop")]);
	t.after(() => view.dispose());
	await Promise.resolve();
	view.focused = true;
	view.render(120);
	view.handleMouse(mouse("move", { button: "none" }));
	assert.ok(!view.render(30).some((line) => stripTerminalSequences(line).endsWith("█")));
	view.handleMouse(mouse("move", { button: "none", x: 29 }));
	assert.ok(view.render(30).some((line) => stripTerminalSequences(line).endsWith("█")));
	view.focused = false;
	assert.ok(!view.render(30).some((line) => stripTerminalSequences(line).endsWith("█")));
	for (const width of [1, 2, 10]) {
		view.render(width);
		view.handleMouse(mouse("move", { button: "none", x: width - 1 }));
		assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("short content shows a full scrollbar thumb without an invalid position", async (t) => {
	const { view } = setup();
	t.after(() => view.dispose());
	await Promise.resolve();
	const lines = view.render(120).map(stripTerminalSequences);
	assert.ok(lines.slice(3, -4).every((line) => line.endsWith("┃")));
	assert.notEqual(view.handleMouse(mouse("press")).capture, true);
	view.handleMouse(mouse("drag", { y: -100 }));
	assert.deepEqual(view.render(120).map(stripTerminalSequences), lines);
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
	view.handleMouse(mouse("wheel", { wheelDelta: -3 }));
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

test("Ctrl+X twice stops a live agent; any other key in between cancels", async (t) => {
	let stops = 0;
	const { view, text } = setup(async () => [], {
		canStop: () => true,
		stop: async () => {
			stops++;
			return undefined;
		},
	});
	t.after(() => view.dispose());
	const CTRL_X = "\x18";
	assert.match(text(), /Ctrl\+X Stop/);

	view.handleInput(CTRL_X);
	assert.match(text(), /Press Ctrl\+X again to stop @test/);
	view.handleInput("a"); // cancels
	assert.doesNotMatch(text(), /Press Ctrl\+X again/);
	view.handleInput(CTRL_X);
	assert.equal(stops, 0, "one press only arms the stop");
	view.handleInput(CTRL_X);
	await new Promise((r) => setImmediate(r));
	assert.equal(stops, 1);
	assert.match(text(), /Stopped/);
});

test("Ctrl+X on an agent with no live process stops nothing", async (t) => {
	let stops = 0;
	const { view, text } = setup(async () => [], {
		canStop: () => false,
		stop: async () => {
			stops++;
			return undefined;
		},
	});
	t.after(() => view.dispose());
	assert.doesNotMatch(text(), /Ctrl\+X Stop/);
	view.handleInput("\x18");
	view.handleInput("\x18");
	await new Promise((r) => setImmediate(r));
	assert.equal(stops, 0);
	assert.match(text(), /nothing to stop/);
});

test("pi's footer lines for the agent sit above the view's key line", async (t) => {
	const sessionManager = SessionManager.inMemory("/work/project");
	const { view } = setup(async () => [], {
		footer: async () => ({
			sessionManager,
			model: { id: "claude-sonnet-5-5", provider: "anthropic", contextWindow: 200_000, reasoning: true } as never,
			thinkingLevel: "high",
			autoCompactionEnabled: true,
			gitBranch: "main",
			providerCount: 1,
			isUsingSubscription: () => false,
			statuses: () => new Map([["web", "web: on"]]),
		}),
	});
	t.after(() => view.dispose());
	await new Promise((r) => setImmediate(r));
	const lines = view.render(120).map(stripTerminalSequences);
	assert.equal(lines.length, 40, "the footer lines come out of the viewport, not past the screen");
	assert.match(lines.at(-4) ?? "", /^\/work\/project \(main\)/);
	assert.match(lines.at(-3) ?? "", /claude-sonnet-5-5 • high/);
	assert.match(lines.at(-2) ?? "", /^web: on/);
	assert.match(lines.at(-1) ?? "", /^\S.*Enter Send .*Esc Back/, "the key line starts in the footer's column");
});
