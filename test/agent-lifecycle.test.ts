import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { type AgentCompletion, AgentProcess } from "../agent-process.js";
import { AgentRegistry } from "../registry.js";
import { RpcClient } from "../rpc-client.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rpc-lifecycle.js");

it("fast RPC settlement preserves turn ownership, output, and idle rows across wakes", async () => {
	const outcomes: Array<Promise<AgentCompletion>> = [];
	const rows: string[] = [];
	const registry = new AgentRegistry({
		notify: () => {},
		getWidget: () => ({ add() {}, remove() {}, dispose() {}, setStatus: (_id, status) => rows.push(status) }),
	});
	const agent: AgentProcess = new AgentProcess(
		{
			cwd: path.dirname(fixture),
			agentId: "fast",
			label: "fast",
			persistent: true,
			onIdle: () => {
				outcomes.push(agent.completionSnapshot());
				registry.markIdle(agent.agentId);
			},
		},
		{ createClient: (options) => new RpcClient({ ...options, command: process.execPath, args: [fixture] }) },
	);
	try {
		assert.deepEqual(await agent.spawnAndSend("first"), { ok: true });
		const first = await agent.waitForCompletion();
		assert.equal(first.status, "completed");
		assert.equal(first.output, "answer 1");
		assert.equal(first.owedToParent, true);
		assert.equal(first.sessionId, "lifecycle", "instant settlement must still await initial session metadata");
		registry.register(agent, "idle");
		assert.equal(await registry.deliver(agent.agentId, "second"), true);
		assert.equal(agent.status, "completed");
		assert.equal(outcomes.length, 1);
		assert.equal((await outcomes[0]).output, "answer 2");
		assert.equal((await outcomes[0]).owedToParent, true);
		assert.notEqual((await outcomes[0]).completionId, first.completionId);
		assert.deepEqual(rows, ["idle"], "deliver must not undo a settlement that happened before its await resumed");
		assert.equal(await registry.deliver(agent.agentId, "/handled"), false);
		assert.equal(agent.status, "completed");
		assert.equal(outcomes.length, 1);
		assert.deepEqual(rows, ["idle"]);
	} finally {
		await agent.stop();
	}
});

it("an idle resident killed by signal releases its address without creating another completion", async () => {
	let client: RpcClient | undefined;
	const notifications: AgentCompletion[] = [];
	const removed: Array<string | undefined> = [];
	const registry = new AgentRegistry({
		notify: (_agent, completion) => {
			notifications.push(completion);
		},
		getWidget: () => ({ add() {}, dispose() {}, remove: (_id, result) => removed.push(result) }),
	});
	let wakeNotifications = 0;
	const agent: AgentProcess = new AgentProcess(
		{
			cwd: path.dirname(fixture),
			agentId: "idle",
			label: "idle",
			persistent: true,
			onIdle: () => {
				wakeNotifications++;
			},
			onExit: () => registry.removeExited(agent, "done"),
		},
		{
			createClient: (options) => {
				client = new RpcClient({ ...options, command: process.execPath, args: [fixture] });
				return client;
			},
		},
	);
	try {
		await agent.spawnAndSend("first");
		const first = await agent.waitForCompletion();
		registry.register(agent, "idle");
		assert.ok(client);
		client.kill("SIGKILL");
		await client.waitForExit();
		assert.equal(registry.lookup(agent.agentId), undefined);
		assert.deepEqual(removed, ["done"]);
		assert.equal(wakeNotifications, 0);
		assert.deepEqual(notifications, []);
		assert.strictEqual(await agent.completionSnapshot(), first);
	} finally {
		await agent.stop();
	}
});
