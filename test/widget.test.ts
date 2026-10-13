import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Roster } from "../roster.js";
import { formatElapsed, Spinner } from "../ui/spinner.js";
import { AgentWidget, activityToRows, pickVisible, renderAgentLine } from "../widget.js";

test("bottom list elapsed time uses English seconds and automatically switches to minutes", () => {
	for (const [ms, expected] of [
		[0, "0.0s"],
		[12345, "12.3s"],
		[59900, "59.9s"],
		[59999, "1m"],
		[60000, "1m"],
		[65000, "1m 5s"],
		[120000, "2m"],
		[3600000, "60m"],
	] as const)
		assert.equal(formatElapsed(ms), expected);
});

test("running and completed bottom rows both use the compact elapsed time", (t) => {
	t.mock.method(Date, "now", () => 65000);
	const entry = { agentId: "max", label: "check", status: "running", startedAt: 0, indent: 0 } as const;
	assert.match(renderAgentLine(entry, theme, new Spinner(), 4, 120), /1m 5s/);
	assert.match(renderAgentLine({ ...entry, status: "done", endedAt: 65000 }, theme, new Spinner(), 4, 120), /1m 5s/);
});

describe("activityToRows — pure data (width clipping lives in the widget render layer)", () => {
	it("maps short tool args to one tool row", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "ls -la" });
		assert.deepEqual(rows, [{ style: "tool", content: "bash: ls -la" }]);
	});

	it("does not truncate long args (render layer clips to terminal width)", () => {
		const rows = activityToRows({ kind: "tool", name: "write", args: "x".repeat(5000) });
		const content = rows[0]?.content ?? "";
		assert.equal(content, `write: ${"x".repeat(5000)}`);
	});

	it("flattens multi-line tool args (heredoc payloads) to a single line", () => {
		const rows = activityToRows({ kind: "tool", name: "bash", args: "cat > /tmp/x.py << 'EOF'\nimport colorsys\nEOF" });
		const content = rows[0]?.content ?? "";
		assert.ok(!content.includes("\n"), "newlines must be flattened");
		assert.match(content, /import colorsys/);
	});

	it("keeps streamed text as-is (no clipping at the data layer)", () => {
		const rows = activityToRows({ kind: "text", text: "y".repeat(1000) });
		assert.equal(rows[0]?.content, "y".repeat(1000));
	});
});

// ── Bottom agent list ────────────────────────────────────
//
// Rows persist after an agent ends (with its terminal status); ending an
// agent also ends its live nested descendants — nothing will report their
// end, since the reporter was the process that died.

/** Capture the widget's component through a mock ui.setWidget. */
const theme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => `<bg>${s}`,
	bold: (s: string) => s,
	italic: (s: string) => s,
	underline: (s: string) => `_${s}_`,
} as never;

function capture() {
	let component: { render(width: number): string[]; handleMouse?(e: unknown): unknown } | undefined;
	let placement: string | undefined;
	let input: ((data: string) => unknown) | undefined;
	const ui = {
		onTerminalInput: (handler: (data: string) => unknown) => {
			input = handler;
			return () => {};
		},
		setWidget: (_key: string, widget: unknown, opts?: { placement?: string }) => {
			placement = opts?.placement;
			component =
				typeof widget === "function"
					? (widget as (tui: unknown, th: unknown) => typeof component)({ requestRender: () => {} }, theme)
					: undefined;
		},
	} as never;
	return {
		ui,
		lines: (width = 100) => component?.render(width) ?? [],
		click: (y: number) => component?.handleMouse?.({ type: "click", button: "left", y }),
		/** Pointer motion over line `y` of a list whose top sits on screen row `top` (0-based). */
		move: (y: number, top = 30) => component?.handleMouse?.({ type: "move", button: "none", y, screenY: top + y }),
		/** A raw SGR motion report at 0-based screen row `row`. */
		rawMove: (row: number) => input?.(`\x1b[<35;10;${row + 1}M`),
		placement: () => placement,
	};
}

const agentRow = (id: string, label: string) =>
	({ agentId: id, label, startedAt: Date.now(), getLatestActivity: () => undefined }) as never;

describe("AgentWidget — the bottom agent list", () => {
	it("renders below the editor, one line per agent plus a hint line", () => {
		const { ui, lines, placement } = capture();
		const w = new AgentWidget(ui, new Roster(), () => {});
		w.add(agentRow("jude", "read-only check"));
		w.add(agentRow("max", "auth module"));
		assert.equal(placement(), "belowEditor");
		const out = lines();
		assert.equal(out.length, 3);
		assert.match(out[0], /@jude\s+read-only check/);
		assert.match(out[1], /@max\s+auth module/);
		assert.match(out[2], /\/agents/);
		w.dispose();
	});

	it("shows a nested local name while clicks retain the scoped identity", () => {
		const { ui, lines, click } = capture();
		const roster = new Roster();
		roster.upsert({
			agentId: "max/sam",
			label: "nested task",
			indent: 1,
			sessionPath: "/s/nested.jsonl",
		});
		let opened: string | undefined;
		const w = new AgentWidget(ui, roster, (id) => {
			opened = id;
		});
		assert.match(lines()[0], /@sam\s+nested task/);
		assert.doesNotMatch(lines()[0], /@max\/sam/);
		click(0);
		assert.equal(opened, "max/sam");
		w.dispose();
	});

	it("keeps a finished agent's row with its status instead of removing it", () => {
		const { ui, lines } = capture();
		const roster = new Roster();
		const w = new AgentWidget(ui, roster, () => {});
		w.add(agentRow("jude", "check"));
		w.remove("jude", "failed");
		assert.equal(roster.get("jude")?.status, "failed");
		assert.match(lines()[0], /\u2717 @jude\s+check\s+failed/);
		w.dispose();
	});

	it("ending a parent ends its live nested descendants (no orphan spinner)", () => {
		const { ui } = capture();
		const roster = new Roster();
		const w = new AgentWidget(ui, roster, () => {});
		w.add(agentRow("a", "Alpha"));
		w.addNested({ agentId: "b", label: "Bravo", startedAt: 0, indent: 1, status: "running", parentId: "a" });
		w.addNested({ agentId: "c", label: "Charlie", startedAt: 0, indent: 2, status: "running", parentId: "b" });
		w.add(agentRow("z", "Zulu"));

		w.remove("a", "done");

		assert.equal(roster.get("a")?.status, "done");
		assert.equal(roster.get("b")?.status, "stopped");
		assert.equal(roster.get("c")?.status, "stopped");
		assert.equal(roster.get("z")?.status, "running", "unrelated rows stay live");
		w.dispose();
	});

	it("a click on an agent line opens that agent; the hint line opens nothing", () => {
		const { ui, lines, click } = capture();
		const opened: string[] = [];
		const w = new AgentWidget(ui, new Roster(), (id) => opened.push(id));
		w.add(agentRow("jude", "one"));
		w.add(agentRow("max", "two"));
		lines(); // a render maps lines to agents
		assert.deepEqual(click(1), { handled: true });
		assert.equal(click(2), undefined);
		assert.deepEqual(opened, ["max"]);
		w.dispose();
	});

	it("every line fits the width, CJK labels included", () => {
		const { ui, lines } = capture();
		const w = new AgentWidget(ui, new Roster(), () => {});
		w.add(
			agentRow(
				"jude",
				"\u540e\u53f0\u53ea\u8bfb\u76ee\u5f55\u68c0\u67e5，\u786e\u8ba4\u6ca1\u6709\u4fee\u6539\u4efb\u4f55\u6587\u4ef6\u5e76\u8fd4\u56de\u7b2c\u4e00\u5c42\u6761\u76ee".repeat(
					2,
				),
			),
		);
		w.updateActivity("jude", { kind: "tool", name: "bash", args: "ls -la /work/project" });
		for (const width of [30, 60, 100]) {
			for (const line of lines(width)) {
				assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${line}`);
			}
		}
		w.dispose();
	});
});

describe("pickVisible — which agents get a line when there are too many", () => {
	const entry = (agentId: string, status: string, endedAt?: number) =>
		({ agentId, label: agentId, status, startedAt: 0, endedAt, indent: 0 }) as never;

	it("shows everything when it fits", () => {
		const all = [entry("a", "done", 1), entry("b", "running")];
		assert.deepEqual(pickVisible(all, 8), { shown: all, hidden: 0 });
	});

	it("keeps live agents, then the most recently finished, in spawn order", () => {
		const all = [entry("a", "done", 1), entry("b", "running"), entry("c", "done", 3), entry("d", "failed", 2)];
		const { shown, hidden } = pickVisible(all, 3);
		assert.deepEqual(
			shown.map((e: { agentId: string }) => e.agentId),
			["b", "c", "d"],
		);
		assert.equal(hidden, 1);
	});
});

describe("AgentWidget — hover feedback", () => {
	it("highlights the agent line under the pointer and leaves the others alone", () => {
		const { ui, lines, move } = capture();
		const w = new AgentWidget(ui, new Roster(), () => {});
		w.add(agentRow("jude", "one"));
		w.add(agentRow("max", "two"));
		lines();
		move(1);
		const out = lines();
		assert.match(out[1], /\u25b8/, "hovered line gets the marker");
		assert.match(out[1], /_two_/, "hovered label is underlined");
		assert.match(out[1], /<bg>/, "hovered line gets the selection background");
		assert.doesNotMatch(out[0], /\u25b8|_one_|<bg>/);
		w.dispose();
	});

	it("drops the highlight when the pointer leaves the list, keeps it while inside", () => {
		const { ui, lines, move, rawMove } = capture();
		const w = new AgentWidget(ui, new Roster(), () => {});
		w.add(agentRow("jude", "one"));
		lines();
		move(0, 30); // list occupies screen rows 30..31 (agent line + hint)
		rawMove(31);
		assert.match(lines()[0], /\u25b8/, "still inside the list");
		rawMove(12);
		assert.doesNotMatch(lines()[0], /\u25b8/, "outside the list");
		w.dispose();
	});

	it("moving onto the hint line clears the highlight", () => {
		const { ui, lines, move } = capture();
		const w = new AgentWidget(ui, new Roster(), () => {});
		w.add(agentRow("jude", "one"));
		lines();
		move(0);
		move(1);
		assert.doesNotMatch(lines()[0], /\u25b8/);
		w.dispose();
	});
});
