import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension, { childPromptNote } from "../index.js";

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
	assert.match(
		text,
		/A child uses agent_send only for non-blocking questions to you; blocking questions and its final report come in its final reply/,
	);
	assert.match(text, /truncated with a path to the full output/);
});

test("spawn describes the configured depth, not the default", () => {
	const spawn = load(2).tools.get("agent_spawn");
	assert.ok(spawn);
	assert.match(spawn.description, /Children can spawn their own sub-agents \(maxDepth=2\)/);
	assert.match(spawn.description, /agent_send only for non-blocking questions/);
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
	assert.match(text, /^Send a message to a direct child\. /);
	assert.doesNotMatch(text, /@parent/);
	assert.match(text, /after the target's current response and tool batch, before its next model request/);
	assert.match(text, /Starts a new model turn for idle children, whose reply arrives as another completion/);
	assert.match(text, /resumes exited children with recoverable saved sessions/);
	assert.match(text, /final reply is returned automatically/);
});

/** Tools a process registers under the given agent env (fresh process: identity is read at load). */
function registeredAs(env: Record<string, string>): Guidance[] {
	const fixture = fileURLToPath(new URL("./fixtures/registered-tools.ts", import.meta.url));
	const out = execFileSync(process.execPath, ["--import", "tsx", fixture], {
		env: { ...process.env, PI_SUBAGENT_AGENT_ID: "", PI_SUBAGENT_DEPTH: "", ...env },
		encoding: "utf8",
	});
	return JSON.parse(out) as Guidance[];
}

test("a child at the depth limit keeps only agent_send, active and restricted to @parent", () => {
	const tools = registeredAs({ PI_SUBAGENT_AGENT_ID: "zoe", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "1" });
	assert.deepEqual(
		tools.map((t) => t.name),
		["agent_send"],
	);
	const send = tools[0] as Guidance & { defaultActive?: boolean };
	assert.equal(send.defaultActive, true);
	assert.match(send.description, /^Send a message to @parent, the agent that spawned you\./);
	assert.match(
		send.description,
		/only for non-blocking questions; blocking questions and your final report go in your final reply/,
	);
	assert.match(send.description, /does not end your turn/);
	assert.match(send.description, /only after that reply ends/);
	assert.doesNotMatch(send.description, /direct child/);
	assert.match(JSON.stringify(send.parameters), /\\"@parent\\" — the agent that spawned you/);
});

test("a child that can spawn reaches its children and @parent, with agent_send active from the start", () => {
	const tools = registeredAs({ PI_SUBAGENT_AGENT_ID: "zoe", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2" });
	const send = tools.find((t) => t.name === "agent_send") as Guidance & { defaultActive?: boolean };
	assert.ok(send);
	assert.equal(send.defaultActive, true);
	assert.match(send.description, /direct child, or to @parent/);
	assert.equal((tools.find((t) => t.name === "agent_spawn") as { defaultActive?: boolean }).defaultActive, false);
});

test("a root session that cannot spawn registers no agent tools", () => {
	assert.deepEqual(registeredAs({ PI_SUBAGENT_MAX_DEPTH: "0" }), []);
});

test("the child prompt note explains both channels up", () => {
	const background = childPromptNote({ foreground: false });
	assert.match(background, /final reply is returned to your parent automatically/);
	assert.match(background, /Use it for your final report and for blocking questions/);
	assert.match(background, /ask the question and end this reply/);
	assert.match(background, /agent_send with to="@parent" only for non-blocking questions/);
	assert.match(background, /send the question and keep working/);
	assert.match(
		background,
		/Your parent's reply appears in your conversation once your current tool calls finish or your turn ends; you do not need to wait or check for it\./,
	);
	assert.match(background, /Do not use agent_send for blocking questions, progress updates, or results/);
	assert.doesNotMatch(background, /waiting for this reply/);

	const foreground = childPromptNote({ foreground: true });
	assert.match(foreground, /Your parent is waiting for this reply and reads agent_send messages only after it ends/);
	assert.match(foreground, /ask non-blocking questions in this reply instead/);
});
