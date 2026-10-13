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

function runHost(t: TestContext, mode: "parallel" | "rejected" | "idle-exit") {
	const dir = mkdtempSync(join(tmpdir(), "pi-revival-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "prompts.jsonl");
	writeFileSync(log, "");
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(dir, "pi"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(child)}\n`, {
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
				REVIVAL_TEST_MODE: mode,
				REVIVAL_TEST_REJECT: mode === "rejected" ? "1" : "0",
			},
			encoding: "utf8",
			timeout: 15000,
		},
	);
	return {
		results: JSON.parse(output) as { isError?: boolean; content: { text: string }[] }[],
		prompts: readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { pid: number; message: string }),
	};
}

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
