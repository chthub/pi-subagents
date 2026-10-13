import assert from "node:assert/strict";
import { test } from "node:test";
import { randomAgentName } from "../name-gen.js";

test("name allocation remains unique after the short-name pool is exhausted", (t) => {
	t.mock.method(Math, "random", () => 0);
	const used = new Set<string>();
	for (let i = 0; i < 400; i++) {
		const name = randomAgentName(used);
		assert.ok(!used.has(name), `must not reuse ${name}`);
		assert.match(name, /^[a-z]+(?:-\d+)?$/);
		used.add(name);
	}
	assert.equal(used.size, 400);
	assert.ok(used.has("ada-2"));
});

test("restored suffixed names are reserved without mutating the used set", (t) => {
	t.mock.method(Math, "random", () => 0);
	const used = new Set<string>();
	for (let i = 0; i < 180; i++) used.add(randomAgentName(used));
	const before = [...used];
	const next = randomAgentName(used);
	assert.ok(!used.has(next));
	assert.deepEqual([...used], before);
});
