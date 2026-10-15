import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
interface RpcRecord {
	kind: string;
	pid: number;
	account: string;
	message?: string;
	text?: string;
	args?: string[];
}
interface Outcome {
	mode: string;
	sessionPath: string;
	results: { isError: boolean; text: string }[];
	hooks: string[];
	notices: { status: string; result: string }[];
	records: RpcRecord[];
}
function run(t: TestContext, mode: string): Outcome {
	const dir = mkdtempSync(join(tmpdir(), "pi-failed-revival-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(dir, "events.jsonl"), "");
	writeFileSync(
		join(dir, "pi"),
		`#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, "test", "fixtures", "failed-revival-rpc.js"))} "$@"\n`,
		{ mode: 0o700 },
	);
	const output = execFileSync(
		process.execPath,
		[
			"--import",
			join(root, "node_modules", "tsx", "dist", "loader.mjs"),
			join(root, "test", "fixtures", "failed-revival-host.ts"),
		],
		{
			cwd: dir,
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				PI_CODING_AGENT_DIR: join(dir, "agent-home"),
				PI_SUBAGENT_CONFIG: join(dir, "absent-config.json"),
				PI_SUBAGENT_AGENT_ID: "",
				PI_SUBAGENT_DEPTH: "0",
				PI_SUBAGENT_MAX_DEPTH: "1",
				FAILED_REVIVAL_MODE: mode,
				FAILED_REVIVAL_LOG: join(dir, "events.jsonl"),
				FAILED_REVIVAL_SESSION: join(dir, "saved.jsonl"),
				FAILED_REVIVAL_RELEASE: join(dir, "release"),
				FAILED_REVIVAL_RESUME_RELEASE: join(dir, "resume-release"),
				FAILED_REVIVAL_REPLACEMENT_RELEASE: join(dir, "replacement-release"),
				SYNTHETIC_ACCOUNT: "not-injected",
			},
			encoding: "utf8",
			timeout: 15000,
		},
	);
	return JSON.parse(output) as Outcome;
}
function assertReplacement(outcome: Outcome) {
	const launches = outcome.records.filter((entry) => entry.kind === "launch");
	assert.equal(launches.length, 2, "one replacement, not a retry loop");
	assert.notEqual(launches[0].pid, launches[1].pid);
	assert.deepEqual(outcome.hooks, ["account-a", "account-b"], "launch hook reads the current synthetic account");
	assert.deepEqual(
		launches.map((entry) => entry.account),
		["account-a", "account-b"],
	);
	for (const [index, launch] of launches.entries()) {
		assert.ok(launch.args);
		assert.equal(launch.args[launch.args.indexOf("--session") + 1], outcome.sessionPath);
		assert.equal(launch.args[launch.args.indexOf("--extension") + 1], `/example/account-${index === 0 ? "a" : "b"}.ts`);
	}
	const oldExit = outcome.records.findIndex((entry) => entry.kind === "exit" && entry.pid === launches[0].pid);
	const freshHook = outcome.records.findIndex((entry) => entry.kind === "hook" && entry.account === "account-b");
	assert.ok(
		oldExit >= 0 && oldExit < freshHook && freshHook < outcome.records.indexOf(launches[1]),
		"old process exits before a fresh launch hook and replacement process",
	);
	const prompts = outcome.records.filter((entry) => entry.kind === "prompt");
	assert.equal(prompts.filter((entry) => entry.message === "old request").length, 1, "never replay the failed request");
	assert.equal(
		outcome.notices.filter((notice) => notice.result === "synthetic quota exhausted").length <= 1,
		true,
		"old captured failure is not duplicated",
	);
	return { launches, prompts };
}

for (const origin of ["tool", "view", "continue"]) {
	for (const terminal of ["recover", "stopped"]) {
		test(`${origin}: new explicit send replaces a ${terminal === "recover" ? "failed" : "stopped"} live child with fresh launch options`, (t) => {
			const outcome = run(t, `${terminal}-${origin}`);
			const { launches, prompts } = assertReplacement(outcome);
			assert.ok(
				outcome.results.every((result) => !result.isError),
				JSON.stringify(outcome.results),
			);
			assert.deepEqual(
				prompts.map((entry) => entry.message),
				["old request", "new request", "parent follow-up"],
			);
			assert.ok(
				prompts.slice(1).every((entry) => entry.pid === launches[1].pid),
				"old completion cannot remove the replacement",
			);
			assert.equal(
				outcome.notices.filter((notice) => notice.result === "reply:new request").length,
				origin === "view" ? 0 : 1,
				"tool sends and /continue notify the parent; ordinary view messages stay private",
			);
			assert.equal(outcome.notices.filter((notice) => notice.result === "reply:parent follow-up").length, 1);
		});
	}

	for (const phase of ["cleanup", "resume"]) {
		test(`${origin}: concurrent sends during ${phase} share one replacement and deliver every new message once`, (t) => {
			const outcome = run(t, `concurrent-${phase}-${origin}`);
			const { launches, prompts } = assertReplacement(outcome);
			assert.ok(
				outcome.results.every((result) => !result.isError),
				JSON.stringify(outcome.results),
			);
			assert.deepEqual(
				prompts.map((entry) => entry.message),
				["old request", "new request", "second new request", "third new request"],
			);
			assert.ok(prompts.slice(1).every((entry) => entry.pid === launches[1].pid));
		});
	}

	for (const health of ["idle", "running"]) {
		test(`${origin}: healthy ${health} resident does not restart after synthetic account changes`, (t) => {
			const outcome = run(t, `healthy-${health}-${origin}`);
			assert.ok(
				outcome.results.every((result) => !result.isError),
				JSON.stringify(outcome.results),
			);
			assert.equal(outcome.records.filter((entry) => entry.kind === "launch").length, 1);
			assert.deepEqual(outcome.hooks, ["account-a"]);
			const prompts = outcome.records.filter((entry) => entry.kind === "prompt");
			assert.equal(prompts.filter((entry) => entry.message === "new request").length, 1);
			assert.ok(prompts.every((entry) => entry.account === "account-a"));
		});
	}

	for (const failure of ["negative", "exit"]) {
		test(`${origin}: ambiguous accepted-message ${failure} failure is surfaced without replay or fallback`, (t) => {
			const outcome = run(t, `ambiguous-${failure}-${origin}`);
			assert.equal(outcome.results[1].isError, true, JSON.stringify(outcome.results));
			assert.equal(outcome.records.filter((entry) => entry.kind === "launch").length, 1);
			assert.deepEqual(outcome.hooks, ["account-a"]);
			assert.deepEqual(
				outcome.records.filter((entry) => entry.kind === "prompt").map((entry) => entry.message),
				["old request", "ambiguous request"],
			);
			if (failure === "exit")
				assert.equal(outcome.records.filter((entry) => entry.kind === "accepted-without-ack").length, 1);
		});
	}

	test(`${origin}: shutdown waits for a rejected replacement's asynchronous cleanup without orphaning it`, (t) => {
		const outcome = run(t, `rejected-replacement-${origin}`);
		const { launches, prompts } = assertReplacement(outcome);
		assert.equal(outcome.results[1].isError, true, JSON.stringify(outcome.results));
		assert.deepEqual(
			prompts.map((entry) => entry.message),
			["old request", "new request"],
		);
		assert.ok(
			launches.every((launch) => outcome.records.some((entry) => entry.kind === "exit" && entry.pid === launch.pid)),
		);
	});

	test(`${origin}: exhausted replacement stops once without respawn loops or old-request replay`, (t) => {
		const outcome = run(t, `quota-again-${origin}`);
		const { prompts } = assertReplacement(outcome);
		assert.deepEqual(
			prompts.map((entry) => entry.message),
			["old request", "new request"],
		);
		const failure = outcome.notices.filter((notice) => notice.result === "synthetic quota still exhausted");
		assert.equal(failure.length, origin === "view" ? 0 : 1);
		assert.ok(failure.every((notice) => notice.status === "failed"));
	});
}

for (const origin of ["tool", "view", "continue"]) {
	for (const action of ["stop", "shutdown"]) {
		test(`${origin}: ${action} begun during asynchronous recovery cleanup cancels all pending sends before replacement launch`, (t) => {
			const outcome = run(t, `cancel-${action}-${origin}`);
			assert.equal(outcome.records.filter((entry) => entry.kind === "launch").length, 1);
			assert.deepEqual(outcome.hooks, ["account-a"]);
			assert.ok(
				outcome.results.slice(1).every((result) => result.isError),
				JSON.stringify(outcome.results),
			);
			assert.deepEqual(
				outcome.records.filter((entry) => entry.kind === "prompt").map((entry) => entry.message),
				["old request"],
			);
		});
	}
}
