import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { buildTranscript } from "../transcript.js";
import { ticker } from "../ui/ticker.js";
import { spawnView } from "../views.js";

initTheme("dark");
const renderers = spawnView as ToolRenderers;
const calls: AssistantMessage["content"] = [
	{ type: "toolCall", id: "call", name: "agent_spawn", arguments: { label: "child", prompt: "work" } },
];
const message: AssistantMessage = {
	role: "assistant",
	content: calls,
	api: "openai-responses",
	provider: "openai",
	model: "test",
	timestamp: 0,
	stopReason: "toolUse",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};
const options = {
	tui: { requestRender() {} } as never,
	cwd: "/work",
	expanded: false,
	renderers: () => renderers,
};

test("disposing a pending transcript only releases UI subscriptions, without a terminal render", () => {
	const before = ticker.subscriberCount;
	const partialStates: boolean[] = [];
	const transcript = buildTranscript([message], {
		...options,
		renderers: () => ({
			...renderers,
			renderCall: (args, theme, context) => {
				partialStates.push(context.isPartial);
				assert.ok(renderers.renderCall);
				return renderers.renderCall(args, theme, context);
			},
		}),
	});
	assert.equal(ticker.subscriberCount, before + 1);
	const detachedTool = transcript.children.at(-1);
	transcript.dispose();
	transcript.dispose();
	detachedTool?.invalidate?.(); // a late UI callback must not restart the clock
	assert.equal(ticker.subscriberCount, before);
	assert.ok(partialStates.every(Boolean), "no fabricated terminal status to stop the renderer");
	assert.equal(transcript.children.length, 0);
});

test("failed transcript construction cleans up clocks already allocated", () => {
	const before = ticker.subscriberCount;
	let resolved = 0;
	assert.throws(
		() =>
			buildTranscript([{ ...message, content: [...calls, { ...calls[0], id: "second" }] }], {
				...options,
				renderers: () => {
					if (++resolved === 2) throw new Error("renderer failure");
					return renderers;
				},
			}),
		/renderer failure/,
	);
	assert.equal(ticker.subscriberCount, before);
});
