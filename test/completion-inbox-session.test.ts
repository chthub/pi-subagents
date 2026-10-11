/** Real Pi session/extension/agent loop, scripted responses only: no model network calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type CompletionNotice, registerCompletionInbox } from "../completion-inbox.js";
import { completionNotification } from "../notification.js";

function result(id: string): CompletionNotice {
	return completionNotification(
		{ agentId: "max", label: "test", stoppedByControl: false, stop: async () => {} },
		{ completionId: id, status: "completed", output: `result ${id}`, stats: { tokens: 1, toolUses: 0, durationMs: 1 } },
	);
}

async function setup(t: TestContext, extra?: (pi: ExtensionAPI, deliver: (id: string) => void) => void) {
	const dir = mkdtempSync(join(tmpdir(), "pi-completion-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let capture!: () => (notice: CompletionNotice) => void;
	let deliver!: (notice: CompletionNotice) => void;
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				capture = registerCompletionInbox(pi).capture;
				extra?.(pi, (id) => deliver(result(id)));
			},
		],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(dir, "models-cache"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	await modelRuntime.setRuntimeApiKey("openai", "offline-test-not-a-real-key");
	const model = getModel("openai", "gpt-4.1");
	assert.ok(model);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		model,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(dir),
		noTools: "builtin",
		thinkingLevel: "off",
	});
	t.after(() => session.dispose());
	const errors: string[] = [];
	await session.bindExtensions({ mode: "rpc", onError: (e) => errors.push(e.error) });
	deliver = capture();
	const requests: string[] = [];
	let reply: (n: number) => Pick<AssistantMessage, "content" | "stopReason"> = () => ({
		content: [{ type: "text", text: "done" }],
		stopReason: "stop",
	});
	session.agent.streamFunction = (_model, context, options) => {
		// Like a real provider, an already-aborted request returns an abort event
		// without making a model/network call. The low-level loop may invoke this
		// after its last tool returns despite the operation being cancelled.
		if (!options?.signal?.aborted) requests.push(JSON.stringify(context.messages));
		if (requests.length > 5) throw new Error("Unexpected model loop in offline test");
		const response: Pick<AssistantMessage, "content" | "stopReason"> = options?.signal?.aborted
			? { content: [], stopReason: "aborted" }
			: reply(requests.length);
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
			...response,
		};
		stream.push({ type: "start", partial: message });
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else if (message.stopReason === "pending") {
			throw new Error("The scripted provider must finish its response");
		} else {
			stream.push({ type: "done", reason: message.stopReason, message });
		}
		stream.end();
		return stream;
	};
	return {
		session,
		requests,
		errors,
		deliver: (id: string) => deliver(result(id)),
		reply: (fn: typeof reply) => {
			reply = fn;
		},
	};
}

test("real loop: three completions during a tool batch enter request 2, not three follow-ups", async (t) => {
	const h = await setup(t, (pi, deliver) => {
		pi.registerTool({
			name: "collect",
			label: "Collect",
			description: "Offline test",
			parameters: Type.Object({}),
			execute: async () => {
				for (const id of ["a:1", "b:1", "c:1"]) deliver(id);
				return { content: [{ type: "text", text: "collected" }], details: undefined };
			},
		});
	});
	h.session.setActiveToolsByName(["collect"]);
	h.reply((n) =>
		n === 1
			? { content: [{ type: "toolCall", id: "call-1", name: "collect", arguments: {} }], stopReason: "toolUse" }
			: { content: [{ type: "text", text: "integrated" }], stopReason: "stop" },
	);
	await h.session.prompt("work");
	assert.equal(h.requests.length, 2);
	for (const id of ["a:1", "b:1", "c:1"]) assert.ok(h.requests[1].includes(id), h.requests[1]);
	assert.equal(h.session.sessionManager.getBranch().filter((e) => e.type === "custom_message").length, 3);
	assert.deepEqual(h.errors, []);
});

test("real idle session: three separate cards are all visible in a single request", async (t) => {
	const h = await setup(t);
	h.deliver("a:1");
	h.deliver("b:1");
	h.deliver("c:1");
	await tick();
	await h.session.waitForIdle();
	assert.equal(h.requests.length, 1);
	for (const id of ["a:1", "b:1", "c:1"]) assert.ok(h.requests[0].includes(id));
	assert.deepEqual(h.errors, []);
});

test("real pre-settle fallback adds all results and makes only one continuation", async (t) => {
	let delivered = false;
	const h = await setup(t, (pi, deliver) => {
		pi.on("agent_end", () => {
			if (delivered) return;
			delivered = true;
			deliver("a:1");
			deliver("b:1");
		});
	});
	await h.session.prompt("work");
	assert.equal(h.requests.length, 2);
	assert.ok(h.requests[1].includes("a:1"));
	assert.ok(h.requests[1].includes("b:1"));
	assert.deepEqual(h.errors, []);
});

test("real user abort during a tool does not turn late completions into a restart", { timeout: 5000 }, async (t) => {
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const h = await setup(t, (pi, deliver) => {
		pi.registerTool({
			name: "wait_for_abort",
			label: "Wait",
			description: "Offline abort test",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) => {
				deliver("a:1");
				entered();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "cancelled" }], details: undefined };
			},
		});
	});
	h.session.setActiveToolsByName(["wait_for_abort"]);
	h.reply(() => ({
		content: [{ type: "toolCall", id: "wait", name: "wait_for_abort", arguments: {} }],
		stopReason: "toolUse",
	}));
	const run = h.session.prompt("work");
	await ready;
	await h.session.abort();
	await run;
	h.deliver("b:1");
	await tick();
	await h.session.waitForIdle();
	assert.equal(h.requests.length, 1);
	assert.ok(JSON.stringify(h.session.messages).includes("a:1"));
	assert.ok(JSON.stringify(h.session.messages).includes("b:1"));
	assert.deepEqual(h.errors, []);
});

test("real aborted response saves a pending result without restarting the model", async (t) => {
	const h = await setup(t);
	h.reply(() => {
		h.deliver("a:1");
		return { content: [], stopReason: "aborted" };
	});
	await h.session.prompt("work");
	h.deliver("b:1");
	await tick();
	await h.session.waitForIdle();
	assert.equal(h.requests.length, 1);
	assert.ok(JSON.stringify(h.session.messages).includes("a:1"));
	assert.ok(JSON.stringify(h.session.messages).includes("b:1"));
	assert.deepEqual(h.errors, []);
});
