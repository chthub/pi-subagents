// Fake pi rpc-mode child for RpcClient tests (spawned via `command: "node"`).
// Protocol: echo each command back with a per-type delay — responses may
// arrive out of order relative to requests, exactly like the real child.
//
// Special command type "split_utf8" writes one response whose UTF-8 bytes are
// split mid-multibyte-character across two stdout chunks (the regression test
// for the StringDecoder double-decode bug).
//
// Special command type "big_line" writes, in ONE stdout write, an agent_end
// event padded to `size` characters followed by agent_settled and the
// response — the shape of a real multi-MB run ending.
import { spawn } from "node:child_process";
import readline from "node:readline";

const DELAYS = { get_state: 60, abort: 40 };

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const cmd = JSON.parse(line);

	if (cmd.type === "response_then_settle") {
		process.stdout.write(`${JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true })}\n${JSON.stringify({ type: "agent_settled" })}\n`);
		return;
	}

	if (cmd.type === "leader_exit_with_child") {
		spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
		process.stdout.write(`${JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true })}\n`, () => process.exit(0));
		return;
	}

	if (cmd.type === "signal_exit") {
		process.kill(process.pid, "SIGKILL");
		return;
	}

	if (cmd.type === "split_utf8") {
		// Cut after the first byte of the second CJK character (three UTF-8 bytes): first chunk ends with
		// an incomplete multibyte sequence, second chunk completes it.
		const payload = JSON.stringify({
			id: cmd.id,
			type: "response",
			command: "split_utf8",
			success: true,
			data: { file: "\u8def\u5f84/\u6587\u4ef6😀" },
		});
		const buf = Buffer.from(`${payload}\n`);
		const cut = Buffer.byteLength("\u8def\u5f84/") + 1;
		process.stdout.write(buf.subarray(0, cut));
		setTimeout(() => process.stdout.write(buf.subarray(cut)), 20);
		return;
	}

	if (cmd.type === "big_line") {
		const big = JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", pad: "x".repeat(cmd.size) }] });
		const settled = JSON.stringify({ type: "agent_settled" });
		const response = JSON.stringify({ id: cmd.id, type: "response", command: "big_line", success: true });
		process.stdout.write(`${big}\n${settled}\n${response}\n`);
		return;
	}

	const delay = DELAYS[cmd.type] ?? 10;
	setTimeout(() => {
		const response = {
			id: cmd.id,
			type: "response",
			command: cmd.type,
			success: true,
			data: { echo: cmd.type },
		};
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}, delay);
});
rl.on("close", () => process.exit(0));
