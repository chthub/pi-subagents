import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { dataCard } from "../../ui/card.js";
import { ticker } from "../../ui/ticker.js";
import { createToolView } from "../../ui/view.js";

initTheme("light");

const theme = { bg: (_k: string, t: string) => t, fg: (_k: string, t: string) => t, bold: (t: string) => t } as never;

const view = createToolView<{ query: string }, { title: string; lines: string[] }>({
	name: "probe",
	title: (ctx) => ctx.args.query,
	tail: (ctx) => (ctx.status === "processing" ? "running…" : ctx.status === "error" ? "failed" : "done"),
	body: {
		rows: {
			of: (ctx) => ctx.result?.data.lines ?? [],
			rows: [{ style: "text", content: (_ctx, item) => String(item) }],
		},
	},
});

/** Minimal pi ToolRenderContext (structural subset). */
function ctx(over: Partial<Record<string, unknown>> = {}) {
	return {
		args: { query: "q1" },
		state: {},
		toolCallId: "c1",
		invalidate: () => {},
		lastComponent: undefined,
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...over,
	} as never;
}

function lines(c: { render(w: number): string[] }, w = 100): string[] {
	return c.render(w);
}

describe("createToolView — header ownership while running", () => {
	it("renderCall renders the header line while processing", () => {
		const st = {};
		const c = ctx({ isPartial: true, state: st });
		const out = lines(view.renderCall({ query: "q1" }, theme, c));
		assert.ok(out.length >= 1, "call renders a header line");
		assert.match(out[0] ?? "", /probe/);
		assert.match(out[0] ?? "", /q1/);
		assert.match(out[0] ?? "", /running/);
		// The processing render starts a clock-driver — end it with a
		// terminal render so the test leaves no subscription behind.
		lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: [] } } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ isPartial: false, state: st }),
			),
		);
	});

	it("renderResult renders a bare body (no header) while processing — call owns the header", () => {
		const out = lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: ["one", "two"] } } },
				{ expanded: false, isPartial: true },
				theme,
				ctx({ isPartial: true }),
			),
		);
		// Body rows present…
		assert.ok(
			out.some((l) => l.includes("one")),
			"body row rendered",
		);
		assert.ok(
			out.some((l) => l.includes("two")),
			"body row rendered",
		);
		// …but the header (name / title / tail) must not repeat.
		assert.ok(!out.some((l) => l.includes("probe")), "no repeated name in streaming result");
		assert.ok(!out.some((l) => l.includes("running")), "no repeated tail in streaming result");
	});

	it("renderResult renders the full card (header + body) once complete", () => {
		const out = lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: ["one"] } } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ isPartial: false }),
			),
		);
		assert.ok(
			out.some((l) => l.includes("probe")),
			"name in final header",
		);
		assert.ok(
			out.some((l) => l.includes("done")),
			"tail in final header",
		);
		assert.ok(
			out.some((l) => l.includes("one")),
			"body row in final card",
		);
	});

	it("renders the view footer below the body", () => {
		const withFooter = createToolView<{ query: string }, { sessionPath?: string }>({
			name: "probe",
			body: { text: () => "body" },
			footer: (ctx) => ctx.result?.data.sessionPath,
		});
		const out = lines(
			withFooter.renderResult(
				{ content: [], details: { data: { sessionPath: "/sessions/abc.jsonl" } } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ isPartial: false }),
			),
		);
		assert.ok(
			out.some((l) => l.includes("/sessions/abc.jsonl")),
			"footer line rendered",
		);
	});

	it("omits the footer when the view returns nothing", () => {
		const noFooter = createToolView<Record<string, unknown>, Record<string, unknown>>({
			name: "probe",
			footer: () => undefined,
		});
		const out = lines(
			noFooter.renderResult(
				{ content: [], details: { data: {} } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ isPartial: false }),
			),
		);
		assert.ok(!out.some((l) => l.includes("session")), "no footer when undefined");
	});

	it("dataCard expanded renders every row (fold lifted)", () => {
		const body = Array.from({ length: 16 }, (_, i) => ({ style: "text" as const, content: `line ${i + 1}` }));
		const collapsed = lines(dataCard({ status: "success", name: "probe", body, expanded: false }, theme));
		const expanded = lines(dataCard({ status: "success", name: "probe", body, expanded: true }, theme));
		assert.ok(
			collapsed.some((l) => l.includes("earlier lines")),
			"collapsed shows the fold hint",
		);
		assert.ok(!expanded.some((l) => l.includes("earlier lines")), "expanded drops the fold hint");
		assert.ok(
			expanded.some((l) => l.includes("line 1")),
			"expanded shows the first row",
		);
		assert.ok(
			expanded.some((l) => l.includes("line 16")),
			"expanded shows the last row",
		);
	});
});

describe("createToolView — clock-driven animation while processing", () => {
	const terminal = (st: Record<string, unknown>) =>
		lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: [] } } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ isPartial: false, state: st }),
			),
		);

	it("drives invalidate on the spinner cadence while processing", async () => {
		let invalidated = 0;
		const st = {};
		lines(
			view.renderCall({ query: "q1" }, theme, ctx({ isPartial: true, state: st, invalidate: () => invalidated++ })),
		);
		assert.equal(invalidated, 0, "no redraw before the first tick");
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(invalidated >= 3, `ticker drives invalidate while processing, got ${invalidated}`);
		terminal(st); // stop the driver
		const after = invalidated;
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(invalidated, after, "no invalidate after the terminal render");
	});

	it("re-renders while processing do not double-subscribe", () => {
		const st = {};
		const c = ctx({ isPartial: true, state: st, invalidate: () => {} });
		lines(view.renderCall({ query: "q1" }, theme, c));
		assert.equal(ticker.subscriberCount, 1);
		lines(view.renderCall({ query: "q1" }, theme, c));
		lines(view.renderCall({ query: "q1" }, theme, c));
		assert.equal(ticker.subscriberCount, 1, "idempotent across re-renders");
		terminal(st);
		assert.equal(ticker.subscriberCount, 0, "terminal render unsubscribes");
	});

	it("streaming result renders do not subscribe (bare body has no animation)", async () => {
		const st = {};
		lines(
			view.renderResult(
				{ content: [], details: { data: { title: "t", lines: ["one"] } } },
				{ expanded: false, isPartial: true },
				theme,
				ctx({ isPartial: true, state: st }),
			),
		);
		assert.equal(ticker.subscriberCount, 0, "bare body renders stay passive");
	});
});

describe("dataCard fields block and wrapping", () => {
	const longValue = "word ".repeat(40).trim();
	const render = (expanded: boolean, width = 40) =>
		dataCard(
			{
				status: "success",
				name: "probe",
				fields: [
					{ key: "mode", value: "background", note: "(default)" },
					{ key: "prompt", value: longValue, fold: 2 },
				],
				body: [{ style: "text", content: longValue }],
				expanded,
			},
			theme,
		).render(width);

	it("wraps field values under a hanging indent and never exceeds the width", () => {
		const lines = render(true);
		const promptLines = lines.slice(lines.findIndex((l) => l.startsWith("prompt")));
		assert.ok(promptLines[1].startsWith("        word"), "continuation lines are indented under the value");
		for (const line of lines) assert.ok(line.length <= 40, `line wider than 40: ${JSON.stringify(line)}`);
		assert.ok(lines.some((l) => l === "mode    background (default)"));
	});

	it("folds a field with `fold` when collapsed and shows it whole when expanded", () => {
		const collapsed = render(false).filter((l) => l.startsWith("        word") || l.startsWith("prompt"));
		assert.equal(collapsed.length, 2);
		assert.ok(render(false).some((l) => l.includes("more lines")));
		assert.ok(render(true).filter((l) => l.startsWith("        word")).length > 2);
	});

	it("expanded body rows wrap to the width (a raw over-wide row used to be clipped)", () => {
		const lines = render(true, 30);
		for (const line of lines) assert.ok(line.trimEnd().length <= 30, `line wider than 30: ${JSON.stringify(line)}`);
		const words = lines.join(" ").match(/word/g) ?? [];
		assert.equal(words.length, 80, "no word of the prompt or the body is dropped");
	});
});
