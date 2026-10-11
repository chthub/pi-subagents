import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ignored = new Set([".git", "node_modules", ".scratch"]);
const textExtensions = new Set([".ts", ".js", ".mjs", ".json", ".md"]);

function sourceFiles(dir = root): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return textExtensions.has(extname(path)) || entry.name === "LICENSE" || entry.name === ".gitignore" ? [path] : [];
	});
}

function locations(patterns: RegExp[], exempt?: string): string[] {
	return sourceFiles().flatMap((path) => {
		const name = relative(root, path);
		if (name === exempt) return [];
		return readFileSync(path, "utf8")
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
