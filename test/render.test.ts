import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderNotification, renderQuestion } from "../render.js";
import { safeTitle } from "../ui/width.js";

// Fold hints render through keyHint, which reads the real global theme.
initTheme("dark");

/**
 * Fake theme: emits real ANSI codes so pi-tui's Text measures true visual
 * widths (it strips ANSI) — asserting on single lines stays reliable. Tags
 * would inflate line widths and make Text wrap mid-phrase.
 */
const theme = new Proxy(
	{},
	{
		get:
			(_, key) =>
			(...args: string[]) =>
				key === "fg" || key === "bg"
					? `\x1b[31m${args[1]}\x1b[0m`
					: key === "bold"
						? `\x1b[1m${args[0]}\x1b[0m`
						: key === "italic"
							? `\x1b[3m${args[0]}\x1b[0m`
							: String(key),
	},
) as never;

function render(component: unknown, width: number): string[] {
	return (component as { render(w: number): string[] }).render(width);
}

/**
 * Rendered text joined across lines — fake-theme tags inflate line widths and
 * make Text wrap mid-phrase, so assertions match on the joined text instead of
 * single lines.
 */
function renderText(component: unknown, width: number): string {
	return render(component, width).map(strip).join("\n");
}

/** Strip real ANSI (keyHint) + fake-theme tags + trailing width padding. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function strip(s: string): string {
	return s
		.replace(ANSI_RE, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\[[a-z]+\]|\[\/[a-z]+\]/g, "")
		.trim();
}

test("notification header carries the status icon", () => {
	const ok = renderNotification(
		{
			details: {
				status: "completed",
				agent_id: "a1",
				label: "research db schema",
				result: "found 5 tables",
				usage: { durationMs: 27500, tokens: 1250, toolUses: 3 },
			},
		},
		{ expanded: false },
		theme,
	);
	assert.ok(renderText(ok, 120).includes('✓ Agent "research db schema" completed'), "completed icon + word");
	// The result text must render in the card body through the internal UI layer.
	assert.ok(renderText(ok, 120).includes("found 5 tables"), "result text renders in the body");

	const failed = renderNotification(
		{
			details: {
				status: "failed",
				agent_id: "a1",
				label: "research db schema",
				result: "partial",
				usage: { durationMs: 12000, tokens: 1100, toolUses: 2 },
			},
		},
		{ expanded: false },
		theme,
	);
	assert.ok(renderText(failed, 120).includes('✗ Agent "research db schema" failed'), "failed icon + word");

	const stopped = renderNotification(
		{
			details: {
				status: "stopped",
				agent_id: "a1",
				label: "slow query probe",
				usage: { durationMs: 3200, tokens: 0, toolUses: 0 },
			},
		},
		{ expanded: false },
		theme,
	);
	assert.ok(renderText(stopped, 120).includes('■ Agent "slow query probe" stopped'), "stopped icon + word");
});

/** The fake theme plus a log of every background key a card asks for. */
function recordingTheme(seen: string[]): never {
	return new Proxy(
		{},
		{
			get:
				(_, key) =>
				(...args: string[]) => {
					if (key === "bg") seen.push(String(args[0]));
					return (theme as unknown as Record<string, (...a: string[]) => string>)[String(key)](...args);
				},
		},
	) as never;
}

test("notification shell wears pi's custom-message background, never a tool box (#31)", () => {
	const seen: string[] = [];
	const t = recordingTheme(seen);
	for (const status of ["completed", "failed", "stopped"] as const) {
		// Box applies its background while rendering, so the card must be drawn.
		renderText(
			renderNotification(
				{ details: { status, agent_id: "a1", label: "x", result: "r", usage: {} } },
				{ expanded: false },
				t,
			),
			120,
		);
	}
	// pi reserves customMessageBg for content that is not a tool call
	// (compaction/branch/skill summaries, renderer-less messages); the tool boxes
	// would make this card read as a tool result.
	assert.deepEqual([...new Set(seen)], ["customMessageBg"], "tool box backgrounds belong to tool cards");
});
test("safeTitle flattens newlines and neutralizes embedded quotes", () => {
	assert.equal(safeTitle('research "db" schema'), "research 'db' schema");
	assert.equal(safeTitle("line1\nline2\t tab"), "line1 line2  tab");
	assert.equal(safeTitle("  padded  "), "padded");
	assert.equal(safeTitle(undefined), "(untitled)");
});

test("safeTitle caps long titles with a trailing ellipsis", () => {
	const long = "a".repeat(100);
	const out = safeTitle(long, 40);
	assert.equal(out.length, 40);
	assert.equal(out.endsWith("…"), true);
});

test("a non-blocking question renders as its own card, not a completion", () => {
	const card = renderQuestion(
		{ details: { agent_id: "zoe", label: "@zoe — schema", question: "Should I include views?" } },
		{ expanded: false },
		theme,
	);
	const text = renderText(card, 120);
	assert.ok(text.includes('? Agent "@zoe — schema" asks (non-blocking)'), text);
	assert.ok(text.includes("Should I include views?"));
	assert.ok(!text.includes("completed"));
});

function mouse(component: Component, overrides: Partial<TuiMouseEvent> = {}) {
	return component.handleMouse?.({
		type: "click",
		button: "left",
		x: 2,
		y: 2,
		screenX: 2,
		screenY: 2,
		width: 120,
		height: component.render(120).length,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	});
}

const longReply = Array.from({ length: 12 }, (_, i) => `reply line ${i + 1}`).join("\n");

for (const status of ["completed", "failed", "stopped"] as const) {
	test(`${status} notification clicks toggle only that message, including separate replies from the same agent`, () => {
		const details = { status, agent_id: "zoe", label: "@zoe — schema", result: longReply };
		const card = renderNotification({ details }, { expanded: false }, theme);
		const other = renderNotification({ details }, { expanded: false }, theme);
		const collapsed = renderText(card, 120);
		assert.ok(collapsed.includes("to expand"));
		assert.ok(!collapsed.includes("reply line 1\n"));

		for (const event of [
			{ type: "click", button: "right" },
			{ type: "drag", button: "left" },
			{ type: "wheel", button: "none", wheelDelta: -1 },
		] as const) {
			assert.equal(mouse(card, event), undefined);
			assert.equal(renderText(card, 120), collapsed);
		}
		assert.deepEqual(mouse(card, { type: "press" }), { handled: true, render: false });
		assert.equal(renderText(card, 120), collapsed, "press arms the click without toggling");
		assert.equal(mouse(card)?.handled, true);
		assert.ok(renderText(card, 120).includes(longReply));
		assert.ok(renderText(other, 120).includes("to expand"));
		mouse(card);
		assert.equal(renderText(card, 120), collapsed);
	});
}

test("question cards are individually clickable", () => {
	const card = renderQuestion(
		{ details: { agent_id: "zoe", label: "schema", question: longReply } },
		{ expanded: false },
		theme,
	);
	const collapsed = renderText(card, 120);
	assert.ok(collapsed.includes("to expand"));
	mouse(card);
	assert.ok(renderText(card, 120).includes(longReply));
	mouse(card);
	assert.equal(renderText(card, 120), collapsed);
});

test("a notification press remains usable when the host rebuilds before release", () => {
	const message = {
		role: "custom" as const,
		customType: "subagent-notification",
		content: "model payload",
		display: true,
		timestamp: 0,
		details: { status: "completed" as const, agent_id: "zoe", label: "schema", result: longReply },
	};
	const host = new CustomMessageComponent(message, (m, options, t) =>
		renderNotification(m as typeof message, options, t),
	);
	const event: TuiMouseEvent = {
		type: "press",
		button: "left",
		x: 2,
		y: 3,
		screenX: 2,
		screenY: 3,
		width: 120,
		height: host.render(120).length,
		shift: false,
		alt: false,
		ctrl: false,
	};
	const pressed = host.handleMouse(event);
	assert.ok(pressed);
	host.invalidate();
	const target = pressed.target;
	target.component.handleMouse?.({
		...event,
		type: "click",
		x: event.screenX - target.originX,
		y: event.screenY - target.originY,
		width: target.width,
		height: target.height,
	});
	assert.ok(
		renderText(host, 120).includes(longReply),
		"the current renderer observes the captured target's fold change",
	);
});

test("Pi custom-message rebuilds preserve local folding; global expansion overrides it", () => {
	const message = {
		role: "custom" as const,
		customType: "subagent-notification",
		content: "model payload",
		display: true,
		timestamp: 0,
		details: { status: "completed" as const, agent_id: "zoe", label: "schema", result: longReply },
	};
	const host = new CustomMessageComponent(message, (m, options, t) =>
		renderNotification(m as typeof message, options, t),
	);
	assert.ok(renderText(host, 120).includes("to expand"));
	mouse(host, { y: 3 });
	assert.ok(renderText(host, 120).includes(longReply));
	host.invalidate();
	assert.ok(renderText(host, 120).includes(longReply), "resize/theme invalidation keeps the local expansion");
	host.setOutputPad(2);
	assert.ok(renderText(host, 120).includes(longReply), "padding rebuild keeps the local expansion");

	host.setExpanded(true);
	assert.ok(renderText(host, 120).includes(longReply));
	mouse(host, { y: 3 });
	assert.ok(renderText(host, 120).includes("to expand"), "a globally expanded card can be collapsed individually");
	host.invalidate();
	assert.ok(renderText(host, 120).includes("to expand"));
	host.setExpanded(false);
	assert.ok(renderText(host, 120).includes("to expand"));
	host.setExpanded(true);
	assert.ok(renderText(host, 120).includes(longReply), "next Ctrl+O overrides the local collapse");
	host.setExpanded(false);
	assert.ok(renderText(host, 120).includes("to expand"));
});
