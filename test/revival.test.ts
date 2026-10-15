import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const host = join(root, "test", "fixtures", "revival-host.ts");
const child = join(root, "test", "fixtures", "revival-rpc.js");

interface LaunchRecord {
	kind: "hook" | "child";
	initial?: { env: Record<string, string>; extensions: string[] };
	args: string[];
	agentId: string;
	depth: string;
	maxDepth: string;
	custom?: string;
	inherited: string;
	agentDir: string;
}

function runHost(
	t: TestContext,
	mode: "parallel" | "rejected" | "idle-exit" | "spawn",
	hook: "none" | "inject" | "error" | "invalid" | "malformed-error" = "none",
) {
	const dir = mkdtempSync(join(tmpdir(), "pi-revival-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "prompts.jsonl");
	writeFileSync(log, "");
	const launchLog = join(dir, "launches.jsonl");
	writeFileSync(launchLog, "");
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(dir, "pi"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(child)} "$@"\n`, {
		mode: 0o700,
	});
	const output = execFileSync(
		process.execPath,
		["--import", join(root, "node_modules", "tsx", "dist", "loader.mjs"), host],
		{
			cwd: dir,
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				PI_SUBAGENT_AGENT_ID: "",
				PI_SUBAGENT_DEPTH: "0",
				PI_SUBAGENT_MAX_DEPTH: "1",
				REVIVAL_TEST_LOG: log,
				REVIVAL_TEST_LAUNCH_LOG: launchLog,
				REVIVAL_TEST_HOOK: hook,
				REVIVAL_TEST_INHERITED: "unchanged",
				LAUNCH_ONLY: "inherited-value",
				PI_CODING_AGENT_DIR: join(dir, "agent-home"),
				REVIVAL_TEST_MODE: mode,
				REVIVAL_TEST_REJECT: mode === "rejected" ? "1" : "0",
			},
			encoding: "utf8",
			timeout: 15000,
		},
	);
	return {
		dir,
		launches: readFileSync(launchLog, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LaunchRecord),
		results: JSON.parse(output) as { isError?: boolean; content: { text: string }[] }[],
		prompts: readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { pid: number; message: string }),
	};
}

for (const mode of ["spawn", "parallel"] as const) {
	for (const hook of ["none", "inject"] as const) {
		test(`child launch event reaches ${mode} construction (${hook}) without persisting launch data`, (t) => {
			const { results, prompts, launches, dir } = runHost(t, mode, hook);
			assert.ok(results.every((result) => !result.isError));
			assert.ok(prompts.length > 0);
			const hookEvents = launches.filter((entry) => entry.kind === "hook");
			assert.equal(hookEvents.length, hook === "inject" ? 1 : 0);
			if (hook === "inject") assert.deepEqual(hookEvents[0].initial, { env: {}, extensions: [] });
			const children = launches.filter((entry) => entry.kind === "child");
			assert.equal(children.length, 1);
			const child = children[0];
			assert.deepEqual(child.args.slice(0, 2), ["--mode", "rpc"]);
			assert.equal(child.depth, "1");
			assert.equal(child.maxDepth, "1");
			assert.ok(child.agentId && child.agentId !== "spoof");
			assert.equal(child.inherited, "unchanged");
			assert.equal(child.agentDir, join(dir, "agent-home"));
			assert.equal(child.custom, hook === "inject" ? "launch-only-value" : "inherited-value");
			const extensionArgs = child.args.flatMap((arg, index) => (arg === "--extension" ? [child.args[index + 1]] : []));
			assert.deepEqual(extensionArgs, hook === "inject" ? ["/example/launch-only-extension.ts"] : []);
			if (mode === "parallel") {
				assert.equal(child.agentId, "max");
				assert.equal(child.args[child.args.indexOf("--session") + 1], join(dir, "saved.jsonl"));
			} else {
				assert.ok(child.args.includes("--name"));
				assert.ok(!child.args.includes("--session"));
			}
		});
	}

	for (const hook of ["error", "invalid", "malformed-error"] as const) {
		test(`invalid hook blocks ${mode} before any child process is created (${hook})`, (t) => {
			const { results, prompts, launches } = runHost(t, mode, hook);
			assert.ok(results.every((result) => result.isError));
			assert.ok(results.every((result) => /pi-subagents:child-launch:v1/.test(result.content[0].text)));
			assert.deepEqual(prompts, []);
			assert.equal(launches.filter((entry) => entry.kind === "child").length, 0);
		});
	}
}

test("launch integration is called again when an exited resident is revived", (t) => {
	const { launches } = runHost(t, "idle-exit", "inject");
	assert.equal(launches.filter((entry) => entry.kind === "hook").length, 2);
	for (const child of launches.filter((entry) => entry.kind === "child")) {
		assert.equal(child.custom, "launch-only-value");
		assert.equal(child.agentId, "max");
		assert.equal(child.args.filter((arg) => arg === "--extension").length, 1);
		assert.ok(child.args.includes("--session"));
	}
});

for (const reject of [false, true]) {
	test(`parallel messages share one revival preflight (${reject ? "rejected" : "accepted"})`, (t) => {
		const { results, prompts } = runHost(t, reject ? "rejected" : "parallel");
		assert.equal(results.length, 3);
		for (const result of results) {
			assert.equal(result.isError === true, reject);
			assert.match(result.content[0].text, reject ? /preflight rejected/ : /delivered the message/);
		}
		assert.equal(new Set(prompts.map((entry) => entry.pid)).size, 1, "one process resumes the saved session");
		assert.deepEqual(
			prompts.map((entry) => entry.message),
			reject ? ["first"] : ["first", "second", "third"],
		);
	});
}

test("agent_send revives an idle resident after unexpected process exit", (t) => {
	const { results, prompts } = runHost(t, "idle-exit");
	assert.equal(results.length, 2);
	for (const result of results) {
		assert.notEqual(result.isError, true);
		assert.match(result.content[0].text, /Resumed @max/);
	}
	assert.deepEqual(
		prompts.map((entry) => entry.message),
		["first", "second"],
	);
	assert.equal(new Set(prompts.map((entry) => entry.pid)).size, 2, "dead resident no longer blocks revival");
});
