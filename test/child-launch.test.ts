import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { CHILD_LAUNCH_EVENT, type ChildLaunch, prepareChildLaunch } from "../child-launch.js";

const identity = {
	PI_SUBAGENT_AGENT_ID: "max",
	PI_SUBAGENT_DEPTH: "1",
	PI_SUBAGENT_MAX_DEPTH: "2",
};

test("no launch listeners adds nothing beyond identity and does not snapshot process.env", () => {
	const launch = prepareChildLaunch(createEventBus(), identity);
	assert.deepEqual(launch, { env: identity, extensions: [] });
	assert.notEqual(launch.env, identity);
	assert.notEqual(launch.env, process.env);
});

test("each launch emits fresh empty data synchronously, composes listeners, and protects identity", () => {
	const events = createEventBus();
	const seen: ChildLaunch[] = [];
	const initial: unknown[] = [];
	const off = events.on(CHILD_LAUNCH_EVENT, (data) => {
		const launch = data as ChildLaunch;
		initial.push(structuredClone(launch));
		seen.push(launch);
		launch.env = { ...identity, PI_SUBAGENT_AGENT_ID: "spoof", PI_SUBAGENT_DEPTH: "99", CUSTOM: "first" };
		launch.extensions.push("/example/bridge.ts");
	});
	const offSecond = events.on(CHILD_LAUNCH_EVENT, (data) => {
		const launch = data as ChildLaunch;
		launch.env.CUSTOM += "-second";
		launch.env.PI_SUBAGENT_MAX_DEPTH = "99";
	});
	const first = prepareChildLaunch(events, identity);
	const second = prepareChildLaunch(events, identity);
	assert.equal(seen.length, 2);
	assert.deepEqual(initial, [
		{ env: {}, extensions: [] },
		{ env: {}, extensions: [] },
	]);
	assert.notEqual(seen[0], seen[1]);
	assert.deepEqual(first, { env: { ...identity, CUSTOM: "first-second" }, extensions: ["/example/bridge.ts"] });
	assert.deepEqual(second, first);
	seen[0].env.CUSTOM = "late";
	seen[0].extensions.push("/example/late.ts");
	assert.equal(first.env.CUSTOM, "first-second");
	assert.deepEqual(first.extensions, ["/example/bridge.ts"]);
	off();
	offSecond();
	assert.deepEqual(prepareChildLaunch(events, identity), { env: identity, extensions: [] });
});

test("emitter exceptions propagate unchanged rather than silently launching", () => {
	const error = new Error("dispatch failed");
	assert.throws(
		() =>
			prepareChildLaunch(
				{
					emit: () => {
						throw error;
					},
				},
				identity,
			),
		(thrown) => thrown === error,
	);
});

test("a listener can fail closed through error even on Pi's exception-catching bus", () => {
	const events = createEventBus();
	events.on(CHILD_LAUNCH_EVENT, (data) => {
		try {
			throw new Error("private detail");
		} catch {
			(data as ChildLaunch).error = "Integration unavailable";
		}
	});
	assert.throws(() => prepareChildLaunch(events, identity), /child launch rejected by integration/);
});

for (const value of ["Integration unavailable", "", "/private/path token=secret", undefined, null, false, 1, {}]) {
	test(`error presence rejects launch without echoing listener data (${typeof value})`, () => {
		assert.throws(
			() =>
				prepareChildLaunch(
					{
						emit: (_name, data) => {
							Object.assign(data as object, { error: value });
						},
					},
					identity,
				),
			(error: unknown) => error instanceof Error && !/private|secret/.test(error.message),
		);
	});
}

const invalid: { field: "env" | "extensions"; value: unknown }[] = [
	...[
		null,
		undefined,
		"value",
		1,
		[],
		new Map(),
		new Date(),
		{ KEY: 1 },
		{ KEY: undefined },
		{ KEY: null },
		{ "": "x" },
		{ "BAD=KEY": "x" },
		{ "BAD\0KEY": "x" },
		{ KEY: "bad\0value" },
		{ [Symbol("key")]: "x" },
		Object.create({ inherited: "x" }),
	].map((value) => ({ field: "env" as const, value })),
	...[null, undefined, "path.ts", {}, [1], [undefined], [null], [""], ["  "], ["bad\0path"], new Array(1)].map(
		(value) => ({ field: "extensions" as const, value }),
	),
];
for (const [index, { field, value }] of invalid.entries()) {
	test(`rejects invalid injected ${field} (${index})`, () => {
		assert.throws(
			() =>
				prepareChildLaunch(
					{
						emit: (_name, data) => {
							Object.assign(data as object, { [field]: value });
						},
					},
					identity,
				),
			TypeError,
		);
	});
}

test("accepts a null-prototype string record and preserves empty string env values", () => {
	const launch = prepareChildLaunch(
		{
			emit: (_name, data) => {
				(data as ChildLaunch).env = Object.assign(Object.create(null), { EMPTY: "" });
			},
		},
		identity,
	);
	assert.deepEqual(launch.env, { EMPTY: "", ...identity });
});
