import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { completionNotification, maybeWriteFullOutput, questionMessage } from "../notification.js";

test("the final reply is marked kind=final_reply in the model-facing payload", () => {
	const notice = completionNotification(
		{ agentId: "zoe", label: "schema", persistent: true, stoppedByControl: false, stop: async () => {} },
		{ completionId: "c1", status: "completed", output: "done", stats: { tokens: 1, toolUses: 0, durationMs: 1 } },
	);
	const content = JSON.parse(notice.content as string);
	assert.equal(content.kind, "final_reply");
	assert.equal(Object.keys(content)[0], "kind");
	assert.equal(content.agent_id, "@zoe");
	assert.equal(content.result, "done");
});

test("overflow markers retain each turn's full report for background and foreground results", (t) => {
	const agent = { agentId: "max", label: "check", persistent: true, stoppedByControl: false, stop: async () => {} };
	const first = `FIRST\n${"a".repeat(60_000)}`;
	const second = `SECOND\n${"b".repeat(60_000)}`;
	const make = (completionId: string, output: string) =>
		completionNotification(agent, {
			completionId,
			status: "completed",
			output,
			stats: { tokens: 1, toolUses: 0, durationMs: 1 },
		});
	const path = (text: string): string => {
		const match = /full output: ([^)]+)/.exec(text);
		assert.ok(match);
		t.after(() => rmSync(dirname(match[1]), { recursive: true, force: true }));
		return match[1];
	};
	const firstPath = path(JSON.parse(make("instance-a:1", first).content as string).result);
	const secondPath = path(JSON.parse(make("instance-a:2", second).content as string).result);
	assert.notEqual(firstPath, secondPath);
	assert.equal(readFileSync(firstPath, "utf8"), first);
	assert.equal(readFileSync(secondPath, "utf8"), second);
	assert.equal(path(maybeWriteFullOutput("max", first)), firstPath, "foreground API can reuse the same report");
	assert.equal(path(JSON.parse(make("instance-b:1", first).content as string).result), firstPath);
});

test("a mid-turn @parent message is marked kind=non_blocking_question", () => {
	const message = questionMessage("zoe", "schema", "Should I include views?");
	assert.equal(message.customType, "subagent-message");
	assert.deepEqual(JSON.parse(message.content), {
		kind: "non_blocking_question",
		agent_id: "@zoe",
		question: "Should I include views?",
	});
	assert.deepEqual(message.details, { agent_id: "zoe", label: "@zoe — schema", question: "Should I include views?" });
	assert.equal(questionMessage("kai", undefined, "q").details.label, "@kai");
});
