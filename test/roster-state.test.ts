import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Roster, type RosterEntry, rosterFromMessages } from "../roster.js";
import { persistRoster, ROSTER_STATE_TYPE, rosterFromBranch } from "../roster-state.js";

const row = (agentId = "max", status: RosterEntry["status"] = "running"): RosterEntry => ({
	agentId,
	label: "check",
	status,
	startedAt: 1000,
	sessionPath: `/s/${agentId}.jsonl`,
	tools: ["read"],
	cwd: "/work",
	indent: 0,
});

function spawn(manager: SessionManager) {
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", name: "agent_spawn", id: "call", arguments: { label: "check", tools: ["read"] } }],
	} as never);
	return manager.appendMessage({
		role: "toolResult",
		toolName: "agent_spawn",
		toolCallId: "call",
		isError: false,
		content: [],
		details: { agentId: "max", sessionPath: "/s/max.jsonl", runInBackground: true },
		timestamp: 1000,
	} as never);
}

test("reload restores pre-compaction agents from full branch history", () => {
	const manager = SessionManager.inMemory("/work");
	spawn(manager);
	const keep = manager.appendMessage({ role: "user", content: "continue", timestamp: 2000 });
	manager.appendCompaction("summary", keep, 10000);
	assert.deepEqual(
		rosterFromMessages(buildSessionContext(manager.getBranch()).messages),
		[],
		"old recovery loses the spawn",
	);
	const [restored] = rosterFromBranch(manager.getBranch(), "/work");
	assert.equal(restored.agentId, "max");
	assert.equal(restored.status, "stopped", "reload does not pretend a dead process is running");
	assert.equal(restored.sessionPath, "/s/max.jsonl");
	assert.deepEqual(restored.tools, ["read"]);
});

test("context edits cannot delete historical UI roster entries", () => {
	const manager = SessionManager.inMemory();
	const resultId = spawn(manager);
	manager.appendContextEdit(resultId, null);
	assert.deepEqual(rosterFromMessages(buildSessionContext(manager.getBranch()).messages), []);
	assert.equal(rosterFromBranch(manager.getBranch())[0]?.agentId, "max");
});

test("snapshot restores nested tool spawns with no independent tool result", () => {
	const manager = SessionManager.inMemory();
	const roster = new Roster();
	const unsubscribe = persistRoster(roster, (type, data) => manager.appendCustomEntry(type, data));
	roster.upsert(row());
	roster.upsert(row("zoe", "idle"));
	unsubscribe();
	const restored = rosterFromBranch(manager.getBranch());
	assert.deepEqual(
		restored.map((e) => [e.agentId, e.status]),
		[
			["max", "stopped"],
			["zoe", "done"],
		],
	);
	assert.equal(restored[0]?.sessionPath, "/s/max.jsonl");
	assert.equal(buildSessionContext(manager.getBranch()).messages.length, 0, "metadata is not model context");
});

test("metadata snapshots ignore activity deltas and detach on shutdown", () => {
	const roster = new Roster();
	const saved: RosterEntry[][] = [];
	const unsubscribe = persistRoster(roster, (type, data) => {
		assert.equal(type, ROSTER_STATE_TYPE);
		saved.push(data.entries);
	});
	roster.upsert(row());
	for (let i = 0; i < 100; i++) roster.setActivity("max", { style: "text", content: String(i) });
	assert.equal(saved.length, 1);
	roster.upsert({ agentId: "max", sessionPath: "/s/new.jsonl" });
	roster.setStatus("max", "done", 2000);
	assert.equal(saved.length, 3);
	assert.equal(saved[0][0].status, "running", "old snapshots are immutable");
	assert.equal(saved[2][0].activity, undefined);
	unsubscribe();
	roster.upsert(row("zoe"));
	assert.equal(saved.length, 3);
});

test("events after a snapshot update the restored roster without losing metadata", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(ROSTER_STATE_TYPE, { entries: [row()] });
	manager.appendCustomMessageEntry("subagent-notification", "done", true, {
		agent_id: "max",
		status: "completed",
		sessionPath: "/s/final.jsonl",
		usage: { durationMs: 5000 },
	});
	const [restored] = rosterFromBranch(manager.getBranch());
	assert.equal(restored.status, "done");
	assert.equal(restored.endedAt, 6000);
	assert.equal(restored.sessionPath, "/s/final.jsonl");
	assert.deepEqual(restored.tools, ["read"]);
});

test("delayed background results do not undo a completed snapshot", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(ROSTER_STATE_TYPE, { entries: [{ ...row("max", "done"), endedAt: 6000 }] });
	spawn(manager);
	const [restored] = rosterFromBranch(manager.getBranch());
	assert.equal(restored.status, "done");
	assert.equal(restored.endedAt, 6000);
	assert.equal(restored.startedAt, 1000);
});

test("standalone completion notifications recover older nested-tool spawns", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomMessageEntry("subagent-notification", "done", true, {
		agent_id: "@max",
		label: "@max — inspect schema",
		status: "completed",
		model: "test",
		sessionPath: "/s/max.jsonl",
	});
	const [restored] = rosterFromBranch(manager.getBranch(), "/work");
	assert.equal(restored.agentId, "max");
	assert.equal(restored.label, "inspect schema");
	assert.equal(restored.status, "done");
	assert.equal(restored.sessionPath, "/s/max.jsonl");
});

test("roster restoration follows the selected branch, not other branches", () => {
	const manager = SessionManager.inMemory();
	const root = manager.appendMessage({ role: "user", content: "root", timestamp: 0 });
	manager.appendCustomEntry(ROSTER_STATE_TYPE, { entries: [row("max")] });
	manager.branch(root);
	manager.appendCustomEntry(ROSTER_STATE_TYPE, { entries: [row("zoe")] });
	assert.deepEqual(
		rosterFromBranch(manager.getBranch()).map((e) => e.agentId),
		["zoe"],
	);
});

test("a failed metadata write cannot crash RPC listeners and is retried", () => {
	const roster = new Roster();
	let attempts = 0;
	let errors = 0;
	const unsubscribe = persistRoster(
		roster,
		() => {
			if (++attempts === 1) throw new Error("write failed");
		},
		() => {
			errors++;
		},
	);
	assert.doesNotThrow(() => roster.upsert(row()));
	assert.equal(errors, 1);
	roster.setActivity("max", { style: "text", content: "retry" });
	assert.equal(attempts, 2);
	unsubscribe();
});

test("corrupt snapshots do not erase recoverable legacy spawn results", () => {
	const manager = SessionManager.inMemory();
	spawn(manager);
	manager.appendCustomEntry(ROSTER_STATE_TYPE, { entries: [{ agentId: "invalid" }] });
	assert.equal(rosterFromBranch(manager.getBranch())[0]?.agentId, "max");
});
