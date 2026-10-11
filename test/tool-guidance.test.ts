import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

type Guidance = Pick<ToolDefinition, "name" | "description" | "promptSnippet" | "promptGuidelines" | "parameters">;
const tools = new Map<string, Guidance>();
extension({
	on: () => () => {},
	registerTool: (tool: Guidance) => tools.set(tool.name, tool),
	registerCommand() {},
	registerMessageRenderer() {},
	registerToolRenderer() {},
} as unknown as ExtensionAPI);

function guidance(name: string): Guidance {
	const tool = tools.get(name);
	assert.ok(tool, `${name} must be registered`);
	return tool;
}

test("tool guidance stays English and leaves coordination policy to the skill", () => {
	for (const name of ["subagent_enable", "agent_spawn", "agent_stop", "agent_send"]) {
		const tool = guidance(name);
		const text = [tool.description, tool.promptSnippet].join("\n");
		assert.doesNotMatch(text, /[\u3400-\u9fff]/u);
		assert.equal(tool.promptGuidelines, undefined);
		assert.doesNotMatch(
			text,
			/Do not routinely|thanks|receipts|prefer agent_send|independent review|not a silent note/,
		);
	}
	assert.match(guidance("subagent_enable").description, /pi-subagents-workflow skill if available/);
});

test("parameter descriptions explain fields without embedding coordination policy", () => {
	const schema = JSON.stringify(guidance("agent_spawn").parameters);
	assert.doesNotMatch(schema, /don't switch|don't change|cheaper model|risky\/looping|cannot do anything useful/);
	assert.match(schema, /Omit to inherit your current model/);
	assert.match(schema, /Tool allowlist/);
});

test("spawn describes automatic replies, batched delivery, and default child capabilities", () => {
	const text = guidance("agent_spawn").description;
	assert.match(text, /final reply is returned automatically, including questions/);
	assert.match(text, /after the current response and tool batch, before the next model request/);
	assert.match(text, /idle parent wakes once for the ready batch/);
	assert.match(text, /default maxDepth=1, children have no agent tools/);
	assert.match(text, /truncated with a path to the full output/);
});

test("stop describes process and execution facts without prescribing a workflow", () => {
	const tool = guidance("agent_stop");
	assert.equal(tool.promptSnippet, "Stop a sub-agent process");
	assert.match(tool.description, /not deleted.*not rolled back.*jobs are not cancelled/);
	assert.match(tool.description, /no new completion notification/);
});

test("send describes delivery, idle model turns, resume, and automatic return", () => {
	const text = guidance("agent_send").description;
	assert.match(text, /direct child, or to @parent when this tool is available in a child/);
	assert.match(text, /after the target's current response and tool batch, before its next model request/);
	assert.match(text, /Starts a new model turn for idle children/);
	assert.match(text, /resumes exited children with recoverable saved sessions/);
	assert.match(text, /final reply is returned automatically/);
});
