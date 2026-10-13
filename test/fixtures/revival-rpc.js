// A resident child with delayed preflight; no model or external configuration.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = process.env.REVIVAL_TEST_LOG;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const cmd = JSON.parse(line);
	if (cmd.type === "prompt") appendFileSync(log, `${JSON.stringify({ pid: process.pid, message: cmd.message })}\n`);
	setTimeout(() => {
		const rejected = cmd.type === "prompt" && process.env.REVIVAL_TEST_REJECT === "1";
		process.stdout.write(
			`${JSON.stringify({
				type: "response",
				id: cmd.id,
				command: cmd.type,
				success: !rejected,
				...(rejected
					? { error: "preflight rejected" }
					: { data: cmd.type === "get_state" ? { sessionFile: "saved.jsonl", sessionId: "test" } : {} }),
			})}\n`,
		);
		if (!rejected && cmd.type === "prompt" && process.env.REVIVAL_TEST_MODE === "idle-exit") {
			setTimeout(() => {
				process.stdout.write(
					`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
				);
				process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
			}, 50);
		}
	}, 30);
});
rl.on("close", () => process.exit(0));
