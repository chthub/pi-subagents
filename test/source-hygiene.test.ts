import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const textExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md"]);

/** Tracked and new (not ignored) files; local ignored files never ship. */
function sourceFiles(): string[] {
	return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\0")
		.filter((name) => {
			if (!name) return false;
			const path = join(root, name);
			// A tracked file deleted in the working tree is still listed.
			if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return false;
			const file = basename(name);
			return textExtensions.has(extname(name)) || file === "LICENSE" || file === ".gitignore";
		});
}

function locations(patterns: RegExp[], exempt?: string): string[] {
	return sourceFiles().flatMap((name) => {
		if (name === exempt) return [];
		return readFileSync(join(root, name), "utf8")
			.split("\n")
			.flatMap((line, index) => (patterns.some((pattern) => pattern.test(line)) ? [`${name}:${index + 1}`] : []));
	});
}

test("only README.zh.md contains literal Han text; CJK fixtures use Unicode escapes", () => {
	assert.deepEqual(locations([/\p{Script=Han}/u], "README.zh.md"), []);
});

test("source has no hard-coded account home paths, institutional storage paths, or credential tokens", () => {
	assert.deepEqual(
		locations([
			/\/(?:home|users|Users)\/[a-zA-Z0-9._-]+\//,
			/\/fs\/(?:ess|scratch)\//,
			/\b(?:ghp_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|sk-[a-zA-Z0-9_-]{30,})\b/,
		]),
		[],
	);
});
