import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Roster, rosterFromMessages } from "../roster.js";

describe("rosterFromMessages — the roster a transcript describes", () => {
	const spawnCall = (id: string, args: object) => ({
		role: "assistant",
		content: [{ type: "toolCall", id, name: "agent_spawn", arguments: args }],
	});
	const spawnResult = (id: string, details: object, isError = false) => ({
		role: "toolResult",
		toolName: "agent_spawn",
		toolCallId: id,
		isError,
		details,
		timestamp: 1000,
	});

	it("rebuilds foreground, background and failed spawns with their call arguments", () => {
		const entries = rosterFromMessages(
			[
				spawnCall("c1", { label: "fg task", tools: ["bash"], timeoutMs: 60000 }),
				spawnResult("c1", { agentId: "max", sessionPath: "/s/max.jsonl", startedAt: 10, endedAt: 20 }),
				spawnCall("c2", { label: "bg task" }),
				spawnResult("c2", { agentId: "jude", label: "bg task", runInBackground: true, sessionPath: "/s/jude.jsonl" }),
				{
					role: "custom",
					customType: "subagent-notification",
					details: { agent_id: "jude", status: "completed", sessionPath: "/s/jude.jsonl", usage: { durationMs: 500 } },
				},
				spawnCall("c3", { label: "broken" }),
				spawnResult("c3", { agentId: "kai", error: "boom" }, true),
				spawnCall("c4", { label: "never started" }),
				spawnResult("c4", { error: 'Model "x" not available.' }, true),
			],
			"/work",
		);
		const byId = Object.fromEntries(entries.map((e) => [e.agentId, e]));
		assert.deepEqual(Object.keys(byId), ["max", "jude", "kai"], "a spawn without an agent id never existed");
		assert.equal(byId.max.status, "done");
		assert.deepEqual(byId.max.tools, ["bash"]);
		assert.equal(byId.max.timeoutMs, 60000, "a revive keeps the per-turn limit");
		assert.equal(byId.max.cwd, "/work");
		assert.equal(byId.jude.status, "done");
		assert.equal(byId.jude.endedAt, byId.jude.startedAt + 500);
		assert.equal(byId.kai.status, "failed");
	});

	it("a background agent with no notification yet was taken down with the old process: stopped", () => {
		const entries = rosterFromMessages([
			spawnCall("c1", { label: "bg" }),
			spawnResult("c1", { agentId: "zoe", runInBackground: true }),
		]);
		assert.equal(entries[0]?.status, "stopped");
	});

	it("a successful agent_stop marks the agent stopped", () => {
		const entries = rosterFromMessages([
			spawnCall("c1", { label: "bg" }),
			spawnResult("c1", { agentId: "zoe", runInBackground: true }),
			{ role: "toolResult", toolName: "agent_stop", details: { agentId: "zoe", label: "bg" }, timestamp: 5 },
		]);
		assert.equal(entries[0]?.status, "stopped");
		assert.equal(entries[0]?.endedAt, 5);
	});
});

describe("Roster", () => {
	it("merges upserts without clobbering fields with undefined", () => {
		const r = new Roster();
		r.upsert({ agentId: "a", label: "Alpha", sessionPath: "/s/a.jsonl" });
		r.upsert({ agentId: "a", sessionPath: undefined, model: "m" });
		assert.equal(r.get("a")?.sessionPath, "/s/a.jsonl");
		assert.equal(r.get("a")?.model, "m");
	});

	it("waking an agent clears its end time; activity is dropped once it ends", () => {
		const r = new Roster();
		r.upsert({ agentId: "a", label: "Alpha" });
		r.setActivity("a", { style: "tool", content: "bash: ls" });
		r.setStatus("a", "done", 100);
		assert.equal(r.get("a")?.activity, undefined);
		assert.equal(r.get("a")?.endedAt, 100);
		r.setStatus("a", "running");
		assert.equal(r.get("a")?.endedAt, undefined);
	});
});
