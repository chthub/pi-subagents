import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { agentTitle, atId, sendView, spawnFields, spawnView, titleFrom } from "../views.js";

initTheme("light");
const theme = { bg: (_k: string, t: string) => t, fg: (_k: string, t: string) => t, bold: (t: string) => t } as never;

function renderSend(details: Record<string, unknown>, args: Record<string, unknown> = {}, isError = false) {
	return sendView
		.renderResult({ content: [], details }, { expanded: false, isPartial: false }, theme, {
			args,
			state: {},
			isPartial: false,
			isError,
		})
		.render(100)
		.join("\n");
}

for (const details of [{ to: "@parent" }, { data: { to: "@parent" } }, {}]) {
	test(`send card displays sent for @parent: ${JSON.stringify(details)}`, () => {
		const out = renderSend(details, { to: "@parent" });
		assert.match(out, /agent_send.*@parent.*sent/);
		assert.doesNotMatch(out, /delivered/);
	});
}

test("send card keeps delivered for direct children, including resumed children", () => {
	for (const details of [{ to: "zoe" }, { to: "zoe", label: "README", agentId: "zoe" }]) {
		assert.match(renderSend(details), /agent_send.*@zoe.*delivered/);
	}
});

test("send card uses the resolved result target before call arguments", () => {
	assert.match(renderSend({ to: "@parent" }, { to: "zoe" }), /@parent.*sent/);
	assert.match(renderSend({ to: "zoe" }, { to: "@parent" }), /@zoe.*delivered/);
});

test("failed sends to @parent never display success", () => {
	for (const out of [
		renderSend({ to: "@parent", error: "root session has no parent" }),
		renderSend({ to: "@parent" }, {}, true),
	]) {
		assert.match(out, /agent_send.*@parent.*failed/);
		assert.doesNotMatch(out, /\bsent\b|delivered/);
	}
});

test("send card displays sending while processing and sent on completion", () => {
	const ctx = { args: { to: "@parent" }, state: {}, isPartial: true, invalidate() {} };
	try {
		const out = sendView.renderCall(ctx.args, theme, ctx).render(100).join("\n");
		assert.match(out, /agent_send.*@parent.*sending/);
		assert.doesNotMatch(out, /\bsent\b|delivered/);
	} finally {
		// End the processing render's animation subscription.
		const done = sendView.renderResult(
			{ content: [], details: { to: "@parent" } },
			{ expanded: false, isPartial: false },
			theme,
			{ ...ctx, isPartial: false },
		);
		assert.match(done.render(100).join("\n"), /agent_send.*@parent.*sent/);
	}
});

test("atId adds @ exactly once", () => {
	assert.equal(atId("max"), "@max");
	// Literal @-form (the protocol routes on it) must never double.
	assert.equal(atId("@max"), "@max");
	assert.equal(atId("@parent"), "@parent");
});

test("titleFrom never renders @@ (double-prefix regression)", () => {
	// agent_send to "@parent": details.to keeps the literal @ (protocol routes
	// on it); the card title must show a single @.
	assert.equal(titleFrom({ result: { data: { to: "@parent", message: "hi" } }, args: {} }, "to"), "@parent");
	// Plain id gets the prefix added once, joined with the label.
	assert.equal(
		titleFrom({ result: { data: { to: "zoe", label: "Research schema" } }, args: {} }, "to"),
		"@zoe — Research schema",
	);
	// agent_stop not-found: executor puts the stripped id in details.agentId
	// (args key is snake_case agent_id — titleFrom only reads details + camel).
	assert.equal(titleFrom({ result: { data: { agentId: "max", error: "x" } }, args: {} }, "agentId"), "@max");
});

test("agentTitle: @id — label (widget rows and notification cards share it)", () => {
	assert.equal(agentTitle("max", "check CI"), "@max — check CI");
});

test("spawnFields: the call record shows each argument as written and what it resolved to", () => {
	const fields = spawnFields(
		{ prompt: "do it", model: "sonnet", tools: ["bash", "read"], persistent: true, timeoutMs: 60000 },
		{ agentId: "max", runInBackground: true, model: "anthropic/claude-sonnet-5-5", thinking: "high" },
	);
	const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
	assert.deepEqual(
		fields.map((f) => f.key),
		["agent", "mode", "model", "thinking", "tools", "prompt"],
	);
	assert.equal(byKey.agent.value, "@max");
	assert.equal(byKey.mode.value, "background \u00b7 persistent \u00b7 timeout 60.0s");
	// run_in_background omitted → the background mode is the default.
	assert.equal(byKey.mode.note, "(default)");
	assert.equal(byKey.model.value, "sonnet \u2192 anthropic/claude-sonnet-5-5");
	assert.deepEqual([byKey.thinking.value, byKey.thinking.note], ["high", "(inherited)"]);
	assert.equal(byKey.tools.value, "bash, read");
	assert.equal(byKey.prompt.value, "do it");
	assert.ok(byKey.prompt.fold, "a long prompt folds when collapsed");
});

test("spawnFields: an empty tool allowlist is explicit and only agent_send is always kept", () => {
	assert.deepEqual(
		spawnFields({ tools: [] }, undefined).find((field) => field.key === "tools"),
		{
			key: "tools",
			value: "[]",
			note: "(agent_send always kept)",
		},
	);
});

test("spawn cards distinguish omitted, empty, and nonempty tool allowlists in every result state", () => {
	for (const [args, expected] of [
		[{}, /tools\s+all\s+\(default\)/],
		[{ tools: [] }, /tools\s+\[\]\s+\(agent_send always kept\)/],
		[{ tools: ["read", "bash"] }, /tools\s+read, bash/],
	] as const) {
		for (const isPartial of [false, true]) {
			for (const expanded of [false, true]) {
				const out = stripTerminalSequences(
					spawnView
						.renderResult(
							{ content: [], details: { agentId: "nora", runInBackground: true } },
							{ expanded, isPartial },
							theme,
							{ args, state: {}, isPartial, isError: false },
						)
						.render(100)
						.join("\n"),
				);
				assert.match(out, expected);
				if ("tools" in args) {
					const toolsLine = out.split("\n").find((line) => /\btools\s/.test(line)) ?? "";
					assert.doesNotMatch(toolsLine, /\ball\b|\(default\)/);
				}
			}
		}
	}
});

test("spawnFields: an explicit foreground call is not marked default; omitted tools read as all", () => {
	const fields = spawnFields({ prompt: "p", run_in_background: false }, { runInBackground: false });
	const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
	assert.equal(byKey.mode.value, "foreground");
	assert.equal(byKey.mode.note, undefined);
	assert.deepEqual([byKey.tools.value, byKey.tools.note], ["all", "(default)"]);
	// Nothing resolved yet (e.g. start failed before the model resolved).
	assert.equal(byKey.model.value, "inherited");
});
