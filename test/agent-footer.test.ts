import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { AgentFooter, type AgentFooterData, finishedContextUsage } from "../agent-footer.js";

initTheme("dark");

const model = { id: "claude-sonnet-5-5", provider: "anthropic", contextWindow: 200_000, reasoning: true } as never;

function session(): SessionManager {
	const manager = SessionManager.inMemory("/work/project");
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		stopReason: "stop",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		timestamp: 1,
		usage: {
			input: 12_000,
			output: 3_400,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15_400,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
	} as never);
	return manager;
}

function data(overrides: Partial<AgentFooterData> = {}): AgentFooterData {
	const sessionManager = overrides.sessionManager ?? session();
	return {
		sessionManager,
		model,
		thinkingLevel: "high",
		contextUsage: "contextUsage" in overrides ? overrides.contextUsage : finishedContextUsage(sessionManager, model),
		autoCompactionEnabled: true,
		gitBranch: "main",
		providerCount: 1,
		isUsingSubscription: () => false,
		statuses: () => new Map([["web", "web: on"]]),
		...overrides,
	};
}

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));

test("renders pi's footer for the child: cwd + branch, usage + context + model, extension statuses", () => {
	const footer = new AgentFooter();
	footer.update(data());
	const [pwd, stats, statuses] = plain(footer.render(100));
	assert.match(pwd ?? "", /\/work\/project \(main\)/);
	assert.match(stats ?? "", /↑12k ↓3\.4k \$0\.030 7\.7%\/200k \(auto\)/);
	assert.match(stats ?? "", /claude-sonnet-5-5 • high$/);
	assert.equal(statuses, "web: on");
});

test("statuses are read at render time", () => {
	const live = new Map<string, string>();
	const footer = new AgentFooter();
	footer.update(data({ statuses: () => live }));
	assert.equal(footer.render(100).length, 2, "no status line without statuses");
	live.set("mcp", "mcp: 2 servers");
	assert.equal(plain(footer.render(100))[2], "mcp: 2 servers");
});

test("renders nothing before data arrives, and a plain line if pi's footer cannot render the child", () => {
	const footer = new AgentFooter();
	assert.deepEqual(footer.render(100), []);
	const broken = { getCwd: () => "/work/project" } as unknown as SessionManager;
	footer.update(data({ sessionManager: broken, contextUsage: undefined }));
	assert.deepEqual(plain(footer.render(100)), [" /work/project  anthropic/claude-sonnet-5-5"]);
});

test("a finished child's context is its last reply's prompt size; unknown without a reply", () => {
	assert.deepEqual(finishedContextUsage(session(), model), { tokens: 15_400, contextWindow: 200_000, percent: 7.7 });
	assert.deepEqual(finishedContextUsage(SessionManager.inMemory("/w"), model), {
		tokens: null,
		contextWindow: 200_000,
		percent: null,
	});
	assert.equal(finishedContextUsage(session(), undefined), undefined);
});
