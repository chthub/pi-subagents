import assert from "node:assert/strict";
import { test } from "node:test";
import { completionNotification, questionMessage } from "../notification.js";

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
