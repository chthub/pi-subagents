import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Box, stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { dataCard } from "../../ui/card.js";
import { sendView, spawnView } from "../../views.js";

initTheme("dark");
const theme = {
	fg: (_key: string, text: string) => text,
	bg: (_key: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const context = (args: Record<string, unknown>) => ({ args, state: {}, isPartial: false, isError: false });
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

function spawn(prompt: string) {
	return spawnView.renderResult(
		{ content: [], details: { label: "narrow", runInBackground: false } },
		{ expanded: false, isPartial: false },
		theme,
		context({ label: "narrow", prompt }),
	);
}

test("narrow field layouts remain within the width, including wide keys and values", () => {
	for (const expanded of [false, true]) {
		const card = dataCard(
			{
				name: "probe",
				status: "success",
				bare: true,
				expanded,
				fields: [
					{ key: "thinking", value: "high", note: "(inherited)" },
					{ key: "\u4e2d\u6587\u5b57\u6bb5", value: "\u4e2d\u6587\u5185\u5bb9".repeat(10), fold: 2 },
				],
			},
			theme,
		);
		for (const width of [1, 2, 8, 12, 16, 20, 30]) {
			for (const line of card.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
	}
	const box = new Box(1, 1);
	box.addChild(spawn("ABCDEFGHIJKLMNOPQRSTUVWXY"));
	for (const width of [12, 16, 20]) assert.ok(box.render(width).every((line) => visibleWidth(line) <= width));
	assert.match(plain(box.render(20)).replace(/\s/g, ""), /ABCDEFGHIJKLMNOPQRSTUVWXY/);
});

test("a narrow spawn update does not crash Pi's real main-screen renderer", () => {
	const terminal = new Proxy(
		{ columns: 20, rows: 40 },
		{ get: (target, key) => (key in target ? Reflect.get(target, key) : () => {}) },
	);
	const tui = new TuiMainScreen(terminal as never, false);
	const box = new Box(1, 1);
	box.addChild(spawn("ABCDEFGHIJKLMNOPQRSTUVWXY"));
	tui.addChild(box);
	try {
		tui.renderNow();
		box.clear();
		box.addChild(spawn("abcdefghijklmnopqrstuvwxyz"));
		assert.doesNotThrow(() => tui.renderNow());
	} finally {
		tui.stop();
	}
});

test("error-only cards render without a body in every preview mode", () => {
	for (const expanded of [false, true]) {
		for (const preview of ["head", "tail"] as const) {
			for (const body of [undefined, [], ""]) {
				const card = dataCard({ name: "probe", status: "error", error: "failure", body, preview, expanded }, theme);
				const text = plain(card.render(40));
				assert.match(text, /✗ probe/);
				assert.match(text, /failure/);
			}
		}
	}
});

test("same-sized result bodies with identical edges never share a preview", () => {
	const prefix = "same beginning ".repeat(3);
	const suffix = "same ending ".repeat(4);
	const render = (middle: string) =>
		dataCard(
			{
				name: "Agent",
				status: "success",
				body: [prefix, middle, "padding line 2", "padding line 3", suffix].join("\n"),
				expanded: false,
			},
			theme,
		);
	const first = render("old old old");
	const second = render("new new new");
	assert.match(plain(first.render(80)), /old old old/);
	assert.match(plain(second.render(80)), /new new new/);
	assert.doesNotMatch(plain(second.render(80)), /old old old/);
	first.render(40);
	first.invalidate();
	assert.match(plain(first.render(80)), /old old old/);
	assert.match(plain(second.render(80)), /new new new/);
});

test("send head preview keeps the first visual lines of a long single logical line", () => {
	const message = `BEGIN ${"a".repeat(600)} END`;
	const render = (expanded: boolean) =>
		plain(
			sendView
				.renderResult(
					{ content: [], details: { to: "max", message } },
					{ expanded, isPartial: false },
					theme,
					context({ to: "max", message }),
				)
				.render(40),
		);
	assert.match(render(false), /BEGIN/);
	assert.doesNotMatch(render(false), /END/);
	assert.match(render(false), /more lines/);
	assert.match(render(true), /BEGIN/);
	assert.match(render(true), /END/);
});
