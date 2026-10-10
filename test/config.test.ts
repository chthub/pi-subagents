import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { canSpawnAt, DEFAULT_CONFIG, envInt, loadConfig, parseConfig } from "../config.js";

describe("parseConfig", () => {
	it("defaults to maxDepth 1 (sub-agents cannot spawn)", () => {
		assert.deepEqual(DEFAULT_CONFIG, { maxDepth: 1 });
		assert.deepEqual(parseConfig("{}"), { config: { maxDepth: 1 }, warnings: [] });
	});

	it("reads maxDepth and ignores unknown keys", () => {
		assert.deepEqual(parseConfig('{"maxDepth": 3, "other": true}'), { config: { maxDepth: 3 }, warnings: [] });
	});

	it("falls back to the default with a warning on an invalid value or file", () => {
		for (const text of ['{"maxDepth": 0}', '{"maxDepth": 1.5}', '{"maxDepth": "2"}', "[1]", "{not json"]) {
			const { config, warnings } = parseConfig(text);
			assert.equal(config.maxDepth, 1, text);
			assert.equal(warnings.length, 1, text);
		}
	});
});

describe("loadConfig", () => {
	it("a missing file is the defaults, silently", () => {
		assert.deepEqual(loadConfig("/nonexistent/pi-subagents.json"), { config: { maxDepth: 1 }, warnings: [] });
	});

	it("warnings name the file", () => {
		const file = path.join(mkdtempSync(path.join(tmpdir(), "pi-subagents-")), "pi-subagents.json");
		writeFileSync(file, '{"maxDepth": -1}');
		const { config, warnings } = loadConfig(file);
		assert.equal(config.maxDepth, 1);
		assert.ok(warnings[0]?.startsWith(file));
	});
});

describe("depth limit", () => {
	it("the main session (depth 0) spawns; with maxDepth 1 its children do not", () => {
		assert.equal(canSpawnAt(0, 1), true);
		assert.equal(canSpawnAt(1, 1), false);
		assert.equal(canSpawnAt(1, 2), true);
		assert.equal(canSpawnAt(2, 2), false);
	});

	it("envInt accepts non-negative integers only", () => {
		assert.equal(envInt("2"), 2);
		assert.equal(envInt("0"), 0);
		for (const v of [undefined, "", "-1", "1.5", "x"]) assert.equal(envInt(v), undefined, String(v));
	});
});
