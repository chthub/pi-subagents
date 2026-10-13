import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { after, describe, it } from "node:test";
import { stashOverflow, truncationMarker } from "../../ui/context.js";

const directories = new Set<string>();
function track(path: string | undefined): string {
	assert.ok(path);
	directories.add(dirname(path));
	return path;
}
after(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("stashOverflow", () => {
	it("keeps the head by default and stashes the full text privately", () => {
		const text = `# Doc\n\n${"x".repeat(100_000)}`;
		const r = stashOverflow(text, "agent-1");
		assert.ok(r.text.startsWith("# Doc"));
		const stash = track(r.stashPath);
		assert.ok(basename(dirname(stash)).startsWith("pi-stash-"));
		assert.ok(existsSync(stash));
		assert.equal(readFileSync(stash, "utf8"), text, "stash holds the FULL text");
		assert.equal(statSync(dirname(stash)).mode & 0o077, 0, "directory is private");
		assert.equal(statSync(stash).mode & 0o077, 0, "output is private");
	});

	it("keep tail keeps the latest (pi-bash style)", () => {
		const text = `${"x".repeat(100_000)}\n\nTHE END`;
		const r = stashOverflow(text, "agent-2", { keep: "tail" });
		assert.ok(r.text.endsWith("THE END"), `tail must be kept, got: …${r.text.slice(-40)}`);
		track(r.stashPath);
	});

	it("different full texts with the same key keep independent immutable files", () => {
		const first = `BEGIN\n${"x".repeat(100_000)}\nEND`;
		const second = `BEGIN\n${"y".repeat(100_000)}\nEND`;
		const a = track(stashOverflow(first, "same-key").stashPath);
		const b = track(stashOverflow(second, "same-key").stashPath);
		assert.notEqual(a, b);
		assert.equal(readFileSync(a, "utf8"), first);
		assert.equal(readFileSync(b, "utf8"), second);
		assert.equal(track(stashOverflow(first, "same-key", { keep: "tail" }).stashPath), a);
	});

	it("independent hosts using the same agent key cannot overwrite each other", () => {
		const text = "host report".repeat(10_000);
		const local = track(stashOverflow(text, "max").stashPath);
		const moduleUrl = new URL("../../ui/context.ts", import.meta.url).href;
		const script = `import { stashOverflow } from ${JSON.stringify(moduleUrl)};
process.stdout.write(stashOverflow(${JSON.stringify(text)}, "max").stashPath);`;
		const remote = track(
			execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
				encoding: "utf8",
				timeout: 10_000,
			}),
		);
		assert.notEqual(dirname(local), dirname(remote));
		assert.equal(readFileSync(local, "utf8"), text);
		assert.equal(readFileSync(remote, "utf8"), text);
	});

	it("short text passes through with no stash", () => {
		const r = stashOverflow("short", "k");
		assert.equal(r.text, "short");
		assert.equal(r.stashPath, undefined);
	});
});

describe("truncationMarker", () => {
	it("embeds the path in the standard inline form", () => {
		assert.equal(
			truncationMarker("/tmp/pi-stash-abc.txt"),
			"\n\n(output truncated — full output: /tmp/pi-stash-abc.txt)",
		);
	});
});
