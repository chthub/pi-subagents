#!/usr/bin/env node
/**
 * End-to-end check against the real `pi` on PATH (spends model tokens).
 *
 * Starts a host `pi --mode rpc -e ./index.ts`, sends one prompt, prints the
 * tool calls / subagent notifications it sees, and exits after the host has
 * finished ENDS agent runs (a notification wakes the host for one more run).
 *
 *   MSG="..." ENDS=2 node test/e2e/rpc-host.mjs
 *
 * Without MSG it runs the background-spawn scenario. Run it after every pi
 * upgrade; unit tests use a mock child and cannot catch rpc protocol drift.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ends = Number(process.env.ENDS || 2);
const message =
	process.env.MSG ||
	"Call agent_spawn once with run_in_background: true, label 'bg-smoke', tools [\"bash\"], prompt: " +
		"'Run: sleep 3; echo BG_OK_$((5*5)) and reply with only the output.' After it is started, reply only 'started'. " +
		"When the completion notification arrives, reply with exactly the result it carries.";

const host = spawn("pi", ["--mode", "rpc", "--no-session", "--thinking", "low", "-e", path.join(root, "index.ts")], {
	cwd: root,
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (command) => host.stdin.write(`${JSON.stringify(command)}\n`);
const timer = setTimeout(() => {
	console.log("TIMEOUT");
	host.kill();
}, 240_000);

let buffer = "";
let agentEnds = 0;
host.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
		const line = buffer.slice(0, i);
		buffer = buffer.slice(i + 1);
		let e;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "tool_execution_start") console.log("TOOL_START", e.toolName, JSON.stringify(e.args).slice(0, 200));
		if (e.type === "tool_execution_end")
			console.log("TOOL_END", e.toolName, `isError=${e.isError}`, JSON.stringify(e.result?.content).slice(0, 200));
		if (e.type === "message_end" && e.message?.role === "custom")
			console.log("CUSTOM_MSG", e.message.customType, String(JSON.stringify(e.message.content)).slice(0, 400));
		if (e.type === "response" && !e.success) console.log("RESP_ERR", JSON.stringify(e));
		if (e.type === "agent_end") {
			agentEnds++;
			console.log("AGENT_END", agentEnds);
			if (agentEnds >= ends) send({ type: "get_last_assistant_text", id: "last" });
		}
		if (e.type === "response" && e.id === "last") {
			console.log("FINAL", JSON.stringify(e.data));
			host.stdin.end();
		}
	}
});
host.on("close", (code) => {
	clearTimeout(timer);
	console.log("HOST_EXIT", code);
});

send({ type: "prompt", id: "p1", message });
