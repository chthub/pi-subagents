import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import type {
	BoundaryResult,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type CompletionNotice, registerCompletionInbox } from "../completion-inbox.js";
import { completionNotification } from "../notification.js";
import { AgentRegistry, type RegisteredAgent } from "../registry.js";

function notice(id: string, result = "done", agentId = "max"): CompletionNotice {
	return completionNotification(
		{ agentId, label: "test", persistent: true, stoppedByControl: false, stop: async () => {} },
		{ completionId: id, status: "completed", output: result, stats: { tokens: 1, toolUses: 0, durationMs: 1 } },
	);
}

function host() {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const sent: { notice: CompletionNotice; triggerTurn: boolean; deliverAs?: string }[] = [];
	let idle = true;
	let controller = new AbortController();
	const ctx = {
		isIdle: () => idle,
		get signal() {
			return controller.signal;
		},
	} as ExtensionContext;
	const inbox = registerCompletionInbox({
		on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		sendMessage: (message: CompletionNotice, options: { triggerTurn?: boolean; deliverAs?: string }) => {
			sent.push({ notice: message, triggerTurn: options.triggerTurn === true, deliverAs: options.deliverAs });
			if (options.triggerTurn) idle = false;
		},
	} as unknown as ExtensionAPI);
	const fire = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx);
	fire("session_start");
	return {
		sent,
		capture: inbox.capture,
		fire,
		start: () => {
			idle = false;
			controller = new AbortController();
			fire("agent_start");
		},
		abort: () => controller.abort(),
		settle: (aborted = false) => {
			idle = true;
			fire("agent_settled", { aborted });
		},
		boundary: (name = "turn_end", outcome = "completed", entries: CustomMessageEntryDraft[] = []) =>
			fire(name, { outcome, entries, continue: false, context: { canContinue: false } }) as BoundaryResult | undefined,
	};
}

function ids(result: BoundaryResult | undefined): string[] {
	return (result?.entries ?? []).flatMap((entry) =>
		entry.type === "custom_message" ? [(entry.details as { completionId: string }).completionId] : [],
	);
}

test("busy parent consumes three results at the next tool/turn boundary, once", async () => {
	const h = host();
	h.start();
	const deliver = h.capture();
	for (const name of ["max", "zoe", "kai"]) deliver(notice(`${name}:1`, "done", name));
	await tick();
	assert.equal(h.sent.length, 0, "no message is inserted among tool calls/results");
	const batch = h.boundary();
	assert.deepEqual(ids(batch), ["max:1", "zoe:1", "kai:1"]);
	assert.equal(batch?.continue, true, "one continuation even when pre-entry canContinue is false");
	assert.equal(h.boundary(), undefined, "no unconditional continuation loop");
	assert.equal(h.boundary("agent_before_settle"), undefined);
	h.settle();
	await tick();
	assert.equal(h.sent.length, 0, "nothing drains after the final answer");
});

test("pre-settle boundary catches a late completion without waiting for other children", () => {
	const h = host();
	h.start();
	assert.equal(h.boundary(), undefined);
	h.capture()(notice("max:1"));
	assert.deepEqual(ids(h.boundary("agent_before_settle")), ["max:1"]);
	assert.equal(h.boundary("agent_before_settle"), undefined);
});

test("idle burst keeps separate cards and starts exactly one run with every result", async () => {
	const h = host();
	const deliver = h.capture();
	for (const id of ["a:1", "b:1", "c:1"]) deliver(notice(id));
	await tick();
	assert.equal(h.sent.length, 3);
	assert.deepEqual(
		h.sent.map((s) => s.triggerTurn),
		[false, false, true],
	);
	assert.ok(h.sent.every((s) => s.deliverAs === "steer"));
	assert.deepEqual(
		h.sent.map((s) => s.notice.details.completionId),
		["a:1", "b:1", "c:1"],
	);
});

test("a new parent run before the scheduled idle flush consumes the batch at its boundary", async () => {
	const h = host();
	h.capture()(notice("a:1"));
	h.start();
	await tick();
	assert.equal(h.sent.length, 0);
	assert.deepEqual(ids(h.boundary()), ["a:1"]);
});

test("same completion id is delivered once, before and after a boundary", () => {
	const h = host();
	h.start();
	const deliver = h.capture();
	deliver(notice("max:1"));
	deliver(notice("max:1"));
	assert.deepEqual(ids(h.boundary()), ["max:1"]);
	deliver(notice("max:1"));
	assert.equal(h.boundary(), undefined);
});

test("different turns of one child are never overwritten or text-filtered", () => {
	const h = host();
	h.start();
	const deliver = h.capture();
	deliver(notice("max:1", "important report"));
	deliver(notice("max:2", "收到"));
	deliver(notice("max:3", "收到"));
	const batch = h.boundary();
	assert.deepEqual(ids(batch), ["max:1", "max:2", "max:3"]);
	assert.match(JSON.stringify(batch), /important report/);
});

test("other extensions' boundary drafts are preserved", () => {
	const h = host();
	h.start();
	h.capture()(notice("max:1"));
	const prior: CustomMessageEntryDraft = {
		type: "custom_message",
		customType: "other",
		content: "keep",
		display: false,
	};
	assert.equal(h.boundary("turn_end", "completed", [prior])?.entries?.[0], prior);
});

test("stopping an agent after completion preserves its queued result", async () => {
	const h = host();
	h.start();
	const deliver = h.capture();
	const registry = new AgentRegistry({
		notify: (agent, completion) => deliver(completionNotification(agent, completion)),
	});
	const agent: RegisteredAgent = {
		agentId: "max",
		label: "test",
		persistent: true,
		stoppedByControl: false,
		stop: async () => {
			agent.stoppedByControl = true;
		},
	};
	registry.register(agent);
	const completion = {
		completionId: "max:1",
		status: "completed" as const,
		output: "report",
		stats: { tokens: 1, toolUses: 0, durationMs: 1 },
	};
	await registry.complete(agent, completion);
	await registry.stopAndRemove("max");
	await registry.complete(agent, completion);
	assert.deepEqual(ids(h.boundary()), ["max:1"]);
});

for (const outcome of ["aborted", "error"]) {
	test(`${outcome}: save results but do not request continuation or wake on later results`, async () => {
		const h = host();
		h.start();
		const deliver = h.capture();
		deliver(notice("max:1"));
		const batch = h.boundary("turn_end", outcome);
		assert.deepEqual(ids(batch), ["max:1"]);
		assert.notEqual(batch?.continue, true);
		h.settle(outcome === "aborted");
		deliver(notice("max:2"));
		await tick();
		assert.deepEqual(
			h.sent.map((s) => s.triggerTurn),
			[false],
		);
		h.start(); // a later accepted run may use the saved results and new ones
		deliver(notice("max:3"));
		assert.equal(h.boundary()?.continue, true);
	});
}

test("abort signal wins even if the last assistant response was completed", async () => {
	const h = host();
	h.start();
	h.capture()(notice("max:1"));
	h.abort();
	assert.notEqual(h.boundary()?.continue, true);
	h.settle(true);
	await tick();
	assert.equal(h.sent.length, 0);
});

test("aborted settlement catches results arriving after the final boundary", async () => {
	const h = host();
	h.start();
	h.boundary();
	h.capture()(notice("max:1"));
	h.settle(true);
	await tick();
	assert.deepEqual(
		h.sent.map((s) => s.triggerTurn),
		[false],
	);
});

test("successful settlement wakes once for a result arriving after pre-settle", async () => {
	const h = host();
	h.start();
	h.boundary("agent_before_settle");
	h.capture()(notice("max:1"));
	h.settle();
	await tick();
	assert.deepEqual(
		h.sent.map((s) => s.triggerTurn),
		[true],
	);
});

test("shutdown cancels idle wake and old callbacks cannot enter a new session", async () => {
	const h = host();
	const old = h.capture();
	old(notice("old:1"));
	h.fire("session_shutdown");
	await tick();
	assert.deepEqual(
		h.sent.map((s) => s.triggerTurn),
		[false],
	);
	h.fire("session_start");
	old(notice("old:2"));
	h.capture()(notice("new:1"));
	await tick();
	assert.deepEqual(
		h.sent.map((s) => s.notice.details.completionId),
		["old:1", "new:1"],
	);
});
