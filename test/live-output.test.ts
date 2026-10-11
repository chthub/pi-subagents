/**
 * Tests for live output routing (live-output.ts): which surfaces hear about a
 * running agent, and the rule that this does not depend on how it was spawned.
 *
 * The bug this pins: a persistent agent spawned in the foreground has a widget
 * row once it becomes resident and no card (its card closed when the spawn
 * returned). Routing its follow-up output to the card alone — the foreground
 * branch — leaves a woken agent silent on every surface it still has.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentActivity } from "../event-interpret.js";
import { type CardSink, createLiveChannels, type LiveAgent, type LiveSurfaces } from "../live-output.js";

const agent = (latest?: AgentActivity): LiveAgent => ({
	agentId: "a1",
	getLatestActivity: () => latest,
});

/** Recording fakes for the two surfaces the widget and the tree provide. */
function surfaces() {
	const calls: string[] = [];
	const widget = {
		updateActivity(agentId: string, activity: AgentActivity | undefined) {
			calls.push(`widget:${agentId}:${activity?.kind ?? "none"}`);
		},
	};
	const tree = {
		activity(a: LiveAgent) {
			calls.push(`tree:${a.agentId}`);
		},
	};
	return { calls, surfaces: { getWidget: () => widget, tree } satisfies LiveSurfaces };
}

function card() {
	const calls: string[] = [];
	const sink: CardSink = {
		delta: (text) => calls.push(`card:delta:${text}`),
		activity: (activity) => calls.push(`card:activity:${activity.kind}`),
	};
	return { calls, sink };
}

describe("createLiveChannels — live output destinations", () => {
	it("foreground spawn with an open card also updates widget and tree for resident wakes", () => {
		const s = surfaces();
		const c = card();
		const live = createLiveChannels({ surfaces: s.surfaces, card: c.sink });

		live.onDelta(agent({ kind: "text", text: "hi" }), "hi");

		assert.deepEqual(s.calls, ["widget:a1:text", "tree:a1"], "both destinations outside the card must receive updates");
		assert.deepEqual(c.calls, ["card:delta:hi"]);
	});

	it("background spawn without a card updates widget and tree", () => {
		const s = surfaces();
		const live = createLiveChannels({ surfaces: s.surfaces });

		live.onDelta(agent({ kind: "text", text: "hi" }), "hi");

		assert.deepEqual(s.calls, ["widget:a1:text", "tree:a1"]);
	});

	it("thinking and tools use the activity channel without duplicating text on the card", () => {
		const s = surfaces();
		const c = card();
		const live = createLiveChannels({ surfaces: s.surfaces, card: c.sink });

		live.onActivity(agent({ kind: "tool", name: "bash", args: "ls" }), { kind: "tool", name: "bash", args: "ls" });
		live.onActivity(agent({ kind: "text", text: "x" }), { kind: "text", text: "x" });

		assert.deepEqual(s.calls, ["widget:a1:tool", "tree:a1", "widget:a1:text", "tree:a1"]);
		assert.deepEqual(c.calls, ["card:activity:tool"], "onDelta delivers text without duplicating it on the card");
	});

	it("widget lookup stays live when the widget is created after construction", () => {
		const calls: string[] = [];
		let widget: { updateActivity(id: string, a: AgentActivity | undefined): void } | undefined;
		const live = createLiveChannels({
			surfaces: { getWidget: () => widget, tree: { activity: (a) => calls.push(`tree:${a.agentId}`) } },
		});

		live.onDelta(agent({ kind: "text", text: "a" }), "a"); // the widget does not exist yet
		widget = { updateActivity: (id, a) => calls.push(`widget:${id}:${a?.kind ?? "none"}`) };
		live.onDelta(agent({ kind: "text", text: "b" }), "b");

		// Second update: widget first (it is in hand now), then the tree.
		assert.deepEqual(
			calls,
			["tree:a1", "widget:a1:text", "tree:a1"],
			"capturing the reference at construction would miss the later widget",
		);
	});

	it("without a widget, tree updates still work", () => {
		const calls: string[] = [];
		const live = createLiveChannels({ surfaces: { tree: { activity: (a) => calls.push(`tree:${a.agentId}`) } } });

		live.onDelta(agent({ kind: "text", text: "hi" }), "hi");

		assert.deepEqual(calls, ["tree:a1"]);
	});

	it("an agent with no latest activity does not invent an update", () => {
		const s = surfaces();
		const c = card();
		const live = createLiveChannels({ surfaces: s.surfaces, card: c.sink });

		live.onDelta(agent(undefined), "hi");

		assert.deepEqual(s.calls, ["widget:a1:none", "tree:a1"]);
		assert.deepEqual(c.calls, ["card:delta:hi"]);
	});
});
