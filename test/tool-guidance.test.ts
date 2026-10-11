import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

type Guidance = Pick<ToolDefinition, "name" | "description" | "promptSnippet" | "promptGuidelines">;
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

test("all model-facing agent descriptions and guidelines remain English", () => {
	for (const name of ["subagent_enable", "agent_spawn", "agent_stop", "agent_send"]) {
		const tool = guidance(name);
		assert.doesNotMatch(
			[tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n"),
			/[\u3400-\u9fff]/u,
		);
	}
});

test("spawn prefers reuse for related work but permits independent fresh-context review", () => {
	const text = guidance("agent_spawn").promptGuidelines?.join("\n") ?? "";
	assert.match(text, /prefer agent_send with the original id/);
	assert.match(text, /saved sessions can be resumed/);
	assert.match(text, /independent review needing fresh context/);
	assert.match(text, /no acknowledgement/);
});

test("stop is cancellation, not routine cleanup or stop-and-respawn", () => {
	const tool = guidance("agent_stop");
	assert.equal(tool.promptSnippet, "Cancel a sub-agent task");
	assert.match(tool.description, /not deleted.*not rolled back/);
	assert.match(tool.promptGuidelines?.join("\n") ?? "", /Do not routinely stop/);
	assert.match(tool.promptGuidelines?.join("\n") ?? "", /prefer agent_send/);
	assert.doesNotMatch(
		tool.promptGuidelines?.join("\n") ?? "",
		/stop it and respawn|Stop a persistent agent when you no longer need it/,
	);
});

test("send explains steering and continuation without encouraging process cleanup", () => {
	const tool = guidance("agent_send");
	assert.match(tool.description, /after the target's current response and tool batch, before its next model request/);
	assert.match(tool.description, /resumes exited children with recoverable saved sessions/);
	assert.match(tool.promptGuidelines?.join("\n") ?? "", /status-only announcements/);
	assert.doesNotMatch(tool.promptGuidelines?.join("\n") ?? "", /release.*process|agent_stop/);
});
