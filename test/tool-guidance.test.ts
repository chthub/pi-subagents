import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

type Guidance = Pick<ToolDefinition, "name" | "description" | "promptSnippet" | "promptGuidelines" | "parameters">;
type Handler = (event: unknown) => unknown;

/** Load the extension at the main session with an explicit maxDepth. */
function load(maxDepth: number): { tools: Map<string, Guidance>; handlers: Map<string, Handler[]> } {
	const tools = new Map<string, Guidance>();
	const handlers = new Map<string, Handler[]>();
	const previous = process.env.PI_SUBAGENT_MAX_DEPTH;
	process.env.PI_SUBAGENT_MAX_DEPTH = String(maxDepth);
	try {
		extension({
			on: (event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
				return () => {};
			},
			registerTool: (tool: Guidance) => tools.set(tool.name, tool),
			registerCommand() {},
			registerMessageRenderer() {},
			registerToolRenderer() {},
		} as unknown as ExtensionAPI);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
		else process.env.PI_SUBAGENT_MAX_DEPTH = previous;
	}
	return { tools, handlers };
}

const { tools } = load(1);

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
	assert.match(text, /Children have no agent tools/);
	assert.match(text, /truncated with a path to the full output/);
});

test("spawn describes the configured depth, not the default", () => {
	const spawn = load(2).tools.get("agent_spawn");
	assert.ok(spawn);
	assert.match(spawn.description, /Children can spawn their own sub-agents \(maxDepth=2\)/);
	assert.doesNotMatch(spawn.description, /no agent tools/);
});

test("run_in_background describes the mode-dependent default", () => {
	const schema = JSON.stringify(guidance("agent_spawn").parameters);
	assert.match(schema, /Default true in interactive and RPC sessions, false in print\/json mode/);
});

test("a process that cannot spawn hides the coordination skill; one that can keeps it", () => {
	const options = () => ({ skills: [{ name: "pi-subagents-workflow" }, { name: "other" }] });
	const names = (event: { systemPromptOptions: { skills: { name: string }[] } }) =>
		event.systemPromptOptions.skills.map((skill) => skill.name);

	const blocked = load(0).handlers.get("before_agent_start") ?? [];
	assert.equal(blocked.length, 1);
	const event = { type: "before_agent_start", prompt: "", systemPromptOptions: options() };
	blocked[0](event);
	assert.deepEqual(names(event), ["other"]);

	assert.deepEqual(load(1).handlers.get("before_agent_start") ?? [], []);
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
	assert.match(text, /Starts a new model turn for idle children, whose reply arrives as another completion/);
	assert.match(text, /resumes exited children with recoverable saved sessions/);
	assert.match(text, /final reply is returned automatically/);
});
