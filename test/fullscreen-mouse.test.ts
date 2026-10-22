import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
	CustomMessageComponent,
	type ExtensionUIContext,
	initTheme,
	ToolExecutionComponent,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	stripTerminalSequences,
	type Terminal,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { renderNotification, renderQuestion } from "../render.js";
import { Roster } from "../roster.js";
import { ticker } from "../ui/ticker.js";
import { spawnView } from "../views.js";
import { AgentWidget } from "../widget.js";

initTheme("dark");
const theme = {
	fg: (_key: string, text: string) => text,
	bg: (_key: string, text: string) => text,
	bold: (text: string) => text,
	underline: (text: string) => text,
} as never;

const WIDTH = 100;
const HEIGHT = 80;
const plain = (component: Component) =>
	component
		.render(WIDTH)
		.map((line) => stripTerminalSequences(line).trim())
		.join("\n");

/** Exercise Pi's parser, hit testing and press/release-to-click synthesis. */
function fullscreen(t: TestContext) {
	let onInput: ((data: string) => void) | undefined;
	let stops = 0;
	const subscribers = ticker.subscriberCount;
	const cleanups: (() => void)[] = [];
	const terminal = new Proxy(
		{
			columns: WIDTH,
			rows: HEIGHT,
			kittyProtocolActive: false,
			start(input: (data: string) => void) {
				onInput = input;
			},
			stop() {
				onInput = undefined;
				stops++;
			},
		},
		{ get: (target, key) => (key in target ? Reflect.get(target, key) : () => {}) },
	) as unknown as Terminal;
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
	t.after(() => {
		for (const cleanup of cleanups.reverse()) cleanup();
		tui.stop(); // Cancels render, selection-autoscroll and hover timers even on assertion failure.
		assert.equal(stops, 1);
		assert.equal(ticker.subscriberCount, subscribers, "no animation subscription escapes the test");
	});

	const input = (data: string) => {
		assert.ok(onInput, "TuiAltScreen.start must install the terminal input callback");
		onInput(data);
		tui.renderNow();
	};
	const report = (button: number, x: number, y: number, release = false) =>
		input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	return {
		tui,
		input,
		report,
		cleanup: (fn: () => void) => cleanups.push(fn),
		start() {
			tui.start();
			tui.renderNow();
		},
		row(text: string) {
			const y = tui
				.getScreenLines()
				.map(stripTerminalSequences)
				.findIndex((line) => line.includes(text));
			assert.ok(y >= 0, `visible mouse target: ${text}`);
			return y;
		},
		click(y: number, beforeRelease?: () => void) {
			report(0, 5, y);
			beforeRelease?.();
			report(0, 5, y, true);
		},
		inertGestures(y: number, unchanged: () => void) {
			for (const button of [1, 2]) {
				report(button, 5, y);
				unchanged();
				report(button, 5, y, true);
				unchanged();
			}
			for (const button of [64, 65]) {
				report(button, 5, y);
				unchanged();
			}
			report(0, 5, y);
			unchanged();
			report(32, 8, y);
			report(32, 5, y); // Returning to the press cell must still count as a drag.
			report(0, 5, y, true);
			unchanged();
		},
	};
}

/** Pi's app.tools.expand action calls setExpanded on the transcript hosts. */
function ctrlO(t: TestContext, screen: ReturnType<typeof fullscreen>, hosts: { setExpanded(value: boolean): void }[]) {
	let expanded = false;
	t.after(
		screen.tui.addInputListener((data) => {
			if (data !== "\x0f") return undefined;
			expanded = !expanded;
			for (const host of hosts) host.setExpanded(expanded);
			return { consume: true };
		}),
	);
	return () => screen.input("\x0f");
}

const prompt = Array.from({ length: 14 }, (_, i) => `prompt line ${i + 1}`).join("\n");
const events = Array.from({ length: 16 }, (_, i) => ({ kind: "text", text: `activity line ${i + 1}` }));

function spawnHost(tui: TuiAltScreen, label: string, isPartial = false) {
	const host = new ToolExecutionComponent(
		"agent_spawn",
		`spawn-${label}`,
		{ label, prompt },
		{ showImages: false },
		spawnView as ToolRenderers,
		tui,
		"/",
	);
	// Completed fixtures stop the constructor's processing animation before start().
	host.updateResult({ content: [], details: { label, runInBackground: false, events }, isError: false }, isPartial);
	return host;
}

function assertSpawnFold(host: Component, expanded: boolean) {
	const text = plain(host);
	assert.equal(text.includes("prompt line 14"), expanded, "prompt and activity share the local fold");
	assert.equal(text.includes("activity line 1\n"), expanded, "early activity is available when expanded");
	assert.equal(text.includes("to expand"), !expanded);
}

test("fullscreen spawnView in ToolExecutionComponent toggles on release, never on drag/right-click/wheel", (t) => {
	const screen = fullscreen(t);
	const host = spawnHost(screen.tui, "mouse spawn");
	screen.tui.addChild(host);
	screen.start();
	assertSpawnFold(host, false);
	const collapsed = plain(host);
	const unchanged = () => assert.equal(plain(host), collapsed);
	screen.inertGestures(screen.row("agent_spawn"), unchanged);
	screen.click(screen.row("agent_spawn"), unchanged);
	assertSpawnFold(host, true);
	assert.equal(screen.tui.hasActiveSelection(), false);
	screen.click(screen.row("activity line 16"), () => assertSpawnFold(host, true));
	assertSpawnFold(host, false);
});

test("fullscreen tool local fold survives host rebuilds and Ctrl+O overrides it", (t) => {
	const screen = fullscreen(t);
	const host = spawnHost(screen.tui, "first spawn");
	const other = spawnHost(screen.tui, "second spawn");
	screen.tui.addChild(host);
	screen.tui.addChild(other);
	const toggleAll = ctrlO(t, screen, [host, other]);
	screen.start();
	screen.click(screen.row("first spawn"));
	assertSpawnFold(host, true);
	assertSpawnFold(other, false);
	host.setExpanded(false); // Reapplying the unchanged global fold must preserve the local expansion.
	host.invalidate();
	host.setOutputPad(2);
	screen.tui.renderNow();
	assertSpawnFold(host, true);

	toggleAll();
	assertSpawnFold(host, true);
	assertSpawnFold(other, true);
	screen.click(screen.row("first spawn"));
	assertSpawnFold(host, false);
	assertSpawnFold(other, true);
	host.invalidate();
	assertSpawnFold(host, false);
	toggleAll();
	assertSpawnFold(host, false);
	assertSpawnFold(other, false);
	toggleAll();
	assertSpawnFold(host, true);
	assertSpawnFold(other, true);
});

test("fullscreen running header and partial result share the fold through updates and completion", (t) => {
	const screen = fullscreen(t);
	const host = spawnHost(screen.tui, "running spawn", true);
	const result = { content: [], details: { label: "running spawn", runInBackground: false, events }, isError: false };
	screen.cleanup(() => host.updateResult(result)); // Stop the running animation even if an assertion fails.
	screen.tui.addChild(host);
	screen.start();
	assertSpawnFold(host, false);
	screen.click(screen.row("agent_spawn"), () => assertSpawnFold(host, false));
	assertSpawnFold(host, true);
	host.setExpanded(false);
	host.invalidate();
	host.updateResult(result, true);
	screen.tui.renderNow();
	assertSpawnFold(host, true);
	screen.click(screen.row("activity line 16"), () => assertSpawnFold(host, true));
	assertSpawnFold(host, false);
	screen.click(screen.row("agent_spawn"));
	assertSpawnFold(host, true);
	host.updateResult(result);
	screen.tui.renderNow();
	assertSpawnFold(host, true);
	assert.match(plain(host), /agent_spawn "running spawn" done/);
});

const reply = Array.from({ length: 12 }, (_, i) => `reply line ${i + 1}`).join("\n");

function notificationHost(kind: "completion" | "question", label = "same agent") {
	const message = {
		role: "custom" as const,
		customType: `subagent-${kind}`,
		content: "model payload",
		display: true,
		timestamp: 0,
		details: { agent_id: "zoe", label, status: "completed", result: reply, question: reply },
	};
	return new CustomMessageComponent(message, (m, options, th) =>
		kind === "completion"
			? renderNotification(m as typeof message, options, th)
			: renderQuestion(m as typeof message, options, th),
	);
}

for (const kind of ["completion", "question"] as const) {
	test(`fullscreen ${kind} notification folds only the clicked message through its Pi host`, (t) => {
		const screen = fullscreen(t);
		const host = notificationHost(kind);
		const other = notificationHost(kind);
		screen.tui.addChild(host);
		screen.tui.addChild(other);
		const toggleAll = ctrlO(t, screen, [host, other]);
		screen.start();
		const collapsed = plain(host);
		assert.match(collapsed, /to expand/);
		assert.doesNotMatch(collapsed, /reply line 1\n/);
		const unchanged = () => assert.equal(plain(host), collapsed);
		screen.inertGestures(screen.row('Agent "same agent"'), unchanged);
		screen.click(screen.row('Agent "same agent"'), unchanged);
		assert.ok(plain(host).includes(reply));
		assert.equal(plain(other), collapsed, "another message from the same agent stays folded");
		host.invalidate();
		host.setOutputPad(2);
		screen.tui.renderNow();
		assert.ok(plain(host).includes(reply), "Pi renderer rebuild keeps the local fold");
		screen.click(screen.row("reply line 12"), () => assert.ok(plain(host).includes(reply)));
		assert.equal(plain(host), collapsed);
		toggleAll();
		assert.ok(plain(host).includes(reply));
		assert.ok(plain(other).includes(reply));
		toggleAll();
		assert.equal(plain(host), collapsed);
	});
}

for (const kind of ["spawn", "completion", "question"] as const) {
	test(`fullscreen ${kind} repeats clicks inside the same word without losing the second click to selection`, (t) => {
		// Keep both clicks in Pi's 500ms multi-click window without relying on machine speed.
		t.mock.method(Date, "now", () => 1000);
		const screen = fullscreen(t);
		const host = kind === "spawn" ? spawnHost(screen.tui, "repeat") : notificationHost(kind, "repeat");
		screen.tui.addChild(host);
		screen.start();
		const y = screen.row(kind === "spawn" ? "agent_spawn" : 'Agent "repeat"');
		assert.match(plain(host), /to expand/);
		screen.click(y);
		assert.doesNotMatch(plain(host), /to expand/);
		assert.equal(screen.row(kind === "spawn" ? "agent_spawn" : 'Agent "repeat"'), y);
		// x=5 lies inside agent_spawn/Agent, away from the word boundary.
		screen.click(y);
		assert.match(plain(host), /to expand/, "the second raw-SGR click must collapse the same card");
	});
}

for (const kind of ["spawn", "completion"] as const) {
	test(`fullscreen ${kind} delivers release to the pressed card after transcript layout moves it`, (t) => {
		const screen = fullscreen(t);
		const prefix = new Text("stream line 1", 0, 0);
		const host = kind === "spawn" ? spawnHost(screen.tui, "moving") : notificationHost(kind, "moving");
		screen.tui.addChild(prefix);
		screen.tui.addChild(host);
		screen.start();
		const title = kind === "spawn" ? "agent_spawn" : 'Agent "moving"';
		const y = screen.row(title);
		screen.click(y, () => {
			prefix.setText("stream line 1\nstream line 2\nstream line 3\nstream line 4");
			screen.tui.renderNow();
			assert.ok(screen.row(title) > y, "transcript update moved the pressed card before release");
			assert.match(stripTerminalSequences(screen.tui.getScreenLines()[y] ?? ""), /stream line 4/);
			assert.match(plain(host), /to expand/, "layout update and press alone do not expand it");
		});
		assert.doesNotMatch(
			plain(host),
			/to expand/,
			"release at the original screen cell still activates the pressed card",
		);
	});
}

test("fullscreen AgentWidget repeats clicks inside an agent id without losing the second navigation", (t) => {
	t.mock.method(Date, "now", () => 1000);
	const screen = fullscreen(t);
	const roster = new Roster();
	roster.upsert({ agentId: "max", label: "repeat navigation", status: "idle" });
	const opened: string[] = [];
	const ui = {
		onTerminalInput: screen.tui.addInputListener.bind(screen.tui),
		setWidget: (_key, factory) => {
			if (typeof factory === "function") screen.tui.addChild(factory(screen.tui, theme) as Component);
		},
	} as Pick<ExtensionUIContext, "onTerminalInput" | "setWidget">;
	const widget = new AgentWidget(ui as ExtensionUIContext, roster, (id) => opened.push(id));
	screen.cleanup(() => widget.dispose());
	screen.start();
	const y = screen.row("@max");
	screen.click(y);
	assert.deepEqual(opened, ["max"]);
	screen.click(y);
	assert.deepEqual(opened, ["max", "max"], "each raw-SGR click invokes navigation, including the rapid second click");
});

test("fullscreen AgentWidget bottom rows open once on release and ignore drags, buttons, wheel and hint", (t) => {
	const screen = fullscreen(t);
	const root = new VStack();
	root.addChild(new Text("editor", 0, 0), { grow: 1 });
	screen.tui.setLayoutRoot(root);
	const ui = {
		onTerminalInput: screen.tui.addInputListener.bind(screen.tui),
		setWidget: (_key, factory, options) => {
			if (typeof factory !== "function") return;
			assert.equal(options?.placement, "belowEditor");
			const component = factory(screen.tui, theme);
			assert.equal(typeof component, "object");
			root.addChild(component as Component, { shrink: 0 });
		},
	} as Pick<ExtensionUIContext, "onTerminalInput" | "setWidget">;
	const roster = new Roster();
	roster.upsert({ agentId: "max", label: "first task", status: "running", startedAt: Date.now() });
	roster.upsert({ agentId: "max/sam", label: "nested task", status: "idle", indent: 1, sessionPath: "/session.jsonl" });
	roster.upsert({ agentId: "max/hidden", label: "no session", status: "idle", indent: 1 });
	const opened: string[] = [];
	const widget = new AgentWidget(ui as ExtensionUIContext, roster, (id) => opened.push(id));
	screen.cleanup(() => widget.dispose());
	screen.start();
	const y = screen.row("nested task");
	assert.equal(y, HEIGHT - 3, "widget is hit-tested at the bottom, below a growing editor area");
	const unchanged = () => assert.deepEqual(opened, []);
	screen.inertGestures(y, unchanged);
	screen.click(y, unchanged);
	assert.deepEqual(opened, ["max/sam"], "nested display name retains its scoped navigation identity");
	screen.click(screen.row("first task"), () => assert.deepEqual(opened, ["max/sam"]));
	assert.deepEqual(opened, ["max/sam", "max"]);
	screen.click(screen.row("no session"));
	screen.click(screen.row("Click to open"));
	assert.deepEqual(opened, ["max/sam", "max"]);
});
