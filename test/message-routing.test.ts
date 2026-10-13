import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MSG_STATUS_KEY } from "../event-interpret.js";
import extension, { handleMessage } from "../index.js";
import { questionMessage } from "../notification.js";
import type { AgentMessage } from "../protocol.js";
import { AgentRegistry, type RegisteredAgent } from "../registry.js";

const question: AgentMessage = { to: "@parent", from: "zoe", message: "Does an interrupted reply clear the result?" };

function setup(hasParent = false) {
	const messages: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const delivered: string[] = [];
	const pi = {
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => messages.push(args),
	} as unknown as ExtensionAPI;
	const registry = new AgentRegistry({ hasParent, notify() {} });
	const child: RegisteredAgent = {
		agentId: "zoe",
		label: "README",
		stoppedByControl: false,
		stop: async () => {},
		sendMessage: async (text) => {
			delivered.push(text);
			return true;
		},
	};
	registry.register(child);
	return { pi, registry, messages, delivered, child };
}

for (const hasParent of [false, true]) {
	test(`inbound @parent reaches the receiving ${hasParent ? "nested" : "root"} agent's session`, async () => {
		const { pi, registry, messages, delivered } = setup(hasParent);
		assert.deepEqual(await handleMessage(pi, registry, question, false), { ok: true, verb: "delivered" });
		assert.deepEqual(messages, [
			[questionMessage("zoe", "README", question.message), { deliverAs: "steer", triggerTurn: true }],
		]);
		assert.deepEqual(delivered, [], "must not bounce an error back to the child");
	});
}

test("outbound @parent from the root still fails without injecting a question", async () => {
	const { pi, registry, messages, delivered } = setup();
	assert.deepEqual(await handleMessage(pi, registry, { ...question, from: "" }, true), {
		ok: false,
		error: "root session has no parent",
	});
	assert.deepEqual(messages, []);
	assert.deepEqual(delivered, []);
});

for (const outbound of [false, true]) {
	test(`${outbound ? "outbound" : "inbound"} direct-child messages retain their sender prefix`, async () => {
		const { pi, registry, messages, delivered } = setup();
		assert.deepEqual(await handleMessage(pi, registry, { to: "@zoe", from: "max", message: "continue" }, outbound), {
			ok: true,
			verb: "delivered",
		});
		assert.deepEqual(delivered, ["[from max] continue"]);
		assert.deepEqual(messages, []);
	});

	test(`${outbound ? "outbound" : "inbound"} unknown targets retain their error handling`, async () => {
		const { pi, registry, messages, delivered } = setup();
		assert.deepEqual(await handleMessage(pi, registry, { ...question, to: "missing" }, outbound), {
			ok: false,
			error: "no such agent: missing",
		});
		assert.deepEqual(messages, []);
		assert.deepEqual(delivered, outbound ? [] : ["[pi-subagent] agent_send to missing failed: no such agent: missing"]);
	});
}

test("failed delivery to a direct child is not reported as success", async () => {
	const { pi, registry, child } = setup();
	child.sendMessage = async () => false;
	assert.deepEqual(await handleMessage(pi, registry, { ...question, to: "zoe" }, true), {
		ok: false,
		error: "delivery to zoe failed",
	});
});

test("outbound @parent emits the payload, reports sent rather than acknowledged delivery, and reaches the root", async () => {
	const tools = new Map<string, ToolDefinition>();
	extension({
		on: () => () => {},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand() {},
		registerMessageRenderer() {},
		registerToolRenderer() {},
	} as unknown as ExtensionAPI);
	const send = tools.get("agent_send");
	assert.ok(send);
	const statuses: [string, string | undefined][] = [];
	const ctx = {
		mode: "rpc",
		ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) },
	} as unknown as Parameters<ToolDefinition["execute"]>[4];
	// Every tool execute captures its RPC UI transport, even on validation failure.
	await send.execute("capture-ui", { to: "", message: "" }, undefined, undefined, ctx);
	const child = setup(true);
	assert.deepEqual(await handleMessage(child.pi, child.registry, question, true), { ok: true, verb: "sent" });
	assert.deepEqual(statuses, [[MSG_STATUS_KEY, JSON.stringify(question)]]);
	assert.deepEqual(child.messages, []);

	const root = setup();
	const payload = statuses[0][1];
	assert.ok(payload);
	assert.deepEqual(await handleMessage(root.pi, root.registry, JSON.parse(payload), false), {
		ok: true,
		verb: "delivered",
	});
	assert.equal(root.messages.length, 1);
	assert.deepEqual(root.delivered, []);
});
