import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantStream } from "../assistant-stream.js";

function message(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		timestamp: 0,
		stopReason: "pending",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("wire indices stay stable while the rendered array is dense and ordered", () => {
	const stream = new AssistantStream(message());
	stream.apply({ type: "text_delta", contentIndex: 3, delta: "third" });
	stream.apply({ type: "text_delta", contentIndex: 0, delta: "first" });
	stream.apply({ type: "toolcall_start", contentIndex: 2, id: "call", toolName: "read" });
	stream.apply({ type: "text_delta", contentIndex: 3, delta: " text" });
	assert.deepEqual(stream.message.content, [
		{ type: "text", text: "first" },
		{ type: "toolCall", id: "call", name: "read", arguments: {} },
		{ type: "text", text: "third text" },
	]);
});

test("start events preserve empty blocks and end events replace accumulated content", () => {
	const stream = new AssistantStream(message());
	stream.apply({ type: "thinking_start", contentIndex: 0 });
	stream.apply({ type: "thinking_delta", contentIndex: 0, delta: "draft thought" });
	stream.apply({ type: "thinking_end", contentIndex: 0, content: "final thought" });
	stream.apply({ type: "text_start", contentIndex: 1 });
	stream.apply({ type: "text_delta", contentIndex: 1, delta: "draft" });
	stream.apply({ type: "text_end", contentIndex: 1, content: "final text" });
	stream.apply({ type: "thinking_start", contentIndex: 2 });
	assert.deepEqual(stream.message.content, [
		{ type: "thinking", thinking: "final thought" },
		{ type: "text", text: "final text" },
		{ type: "thinking", thinking: "" },
	]);
});

test("tool-only streams retain authoritative tool calls and metadata", () => {
	const stream = new AssistantStream(message());
	stream.apply({ type: "toolcall_start", contentIndex: 0, id: "call", toolName: "read" });
	assert.equal(stream.apply({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":' }), false);
	const toolCall = {
		type: "toolCall" as const,
		id: "call",
		name: "read",
		arguments: { path: "x" },
		thoughtSignature: "opaque",
	};
	stream.apply({ type: "toolcall_end", contentIndex: 0, toolCall });
	assert.deepEqual(stream.message.content, [toolCall]);
	toolCall.arguments.path = "changed";
	assert.notDeepEqual(stream.message.content, [toolCall], "do not mutate the received event payload");
});

test("seeded content is copied and signatures survive appended and finalized text", () => {
	const original = message([{ type: "text", text: "seed", textSignature: "opaque" }]);
	const stream = new AssistantStream(original);
	stream.apply({ type: "text_delta", contentIndex: 0, delta: " appended" });
	assert.deepEqual(stream.message.content, [{ type: "text", text: "seed appended", textSignature: "opaque" }]);
	stream.apply({ type: "text_end", contentIndex: 0, content: "final" });
	assert.deepEqual(stream.message.content, [{ type: "text", text: "final", textSignature: "opaque" }]);
	assert.deepEqual(original.content, [{ type: "text", text: "seed", textSignature: "opaque" }]);
});

test("unknown events and invalid indices cannot corrupt renderer content", () => {
	const stream = new AssistantStream(message());
	for (const raw of [
		undefined,
		null,
		"text_delta",
		{},
		{ type: "text_delta", delta: "x" },
		...[-1, 0.5, NaN, Infinity, "1"].map((contentIndex) => ({ type: "text_delta", contentIndex, delta: "x" })),
		{ type: "text_delta", contentIndex: 0, delta: null },
		{ type: "text_end", contentIndex: 0, content: undefined },
		{ type: "toolcall_start", contentIndex: 0 },
		{ type: "toolcall_end", contentIndex: 0 },
		{ type: "unknown", contentIndex: 0 },
	])
		assert.equal(stream.apply(raw), false);
	assert.deepEqual(stream.message.content, []);
});
