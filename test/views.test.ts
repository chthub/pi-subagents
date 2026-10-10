import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTitle, atId, spawnFields, titleFrom } from "../views.js";

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

test("spawnFields: an explicit foreground call is not marked default; omitted tools read as all", () => {
	const fields = spawnFields({ prompt: "p", run_in_background: false }, { runInBackground: false });
	const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
	assert.equal(byKey.mode.value, "foreground");
	assert.equal(byKey.mode.note, undefined);
	assert.deepEqual([byKey.tools.value, byKey.tools.note], ["all", "(default)"]);
	// Nothing resolved yet (e.g. start failed before the model resolved).
	assert.equal(byKey.model.value, "inherited");
});
