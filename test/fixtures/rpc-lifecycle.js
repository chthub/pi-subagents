// Token-free RPC lifecycle fixture: complete each accepted prompt in the same
// write as its preflight response, exercising transport/semantic ordering.
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let turns = 0;
let output = "";
let queued = false;
const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
input.on("line", (line) => {
	const command = JSON.parse(line);
	const response = { id: command.id, type: "response", command: command.type, success: true };
	if (command.type === "prompt") {
		if (command.message === "/handled") {
			write({ ...response, data: { disposition: "handled" } });
			return;
		}
		if (command.message === "/queue-reports") {
			queued = true;
			write({ ...response, data: { disposition: "started" } });
			write({ type: "agent_start" });
			return;
		}
		if (queued) {
			queued = false;
			write({ ...response, data: { disposition: "queued" } });
			write({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first full report" }] },
			});
			write({ type: "turn_end" });
			write({ type: "message_end", message: { role: "user", content: command.message } });
			write({
				type: "message_end",
				message: {
					role: "assistant", stopReason: "toolUse",
					content: [{ type: "text", text: "checking supplementary evidence" }, { type: "toolCall", name: "read" }],
				},
			});
			output = "second supplementary report";
			write({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: output }] },
			});
			write({ type: "agent_end", messages: [], willRetry: false });
			write({ type: "agent_settled", aborted: false });
			return;
		}
		output = `answer ${++turns}`;
		process.stdout.write(
			[
				{ ...response, data: { disposition: "started" } },
				{ type: "agent_start" },
				{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }] } },
				{ type: "agent_settled", aborted: false },
			].map((record) => `${JSON.stringify(record)}\n`).join(""),
		);
		if (command.message === "/background") {
			// Like an extension's sendMessage({ triggerTurn: true }): no parent
			// prompt response accompanies this later resident wake.
			setTimeout(() => {
				output = `background answer ${++turns}`;
				write({ type: "agent_start" });
				write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: output }] } });
				write({ type: "agent_settled", aborted: false });
			}, 30);
		}
		return;
	}
	const data = command.type === "get_state"
		? { sessionFile: "/tmp/lifecycle-session.jsonl", sessionId: "lifecycle" }
		: command.type === "get_last_assistant_text"
			? { text: output }
			: command.type === "get_session_stats"
				? { tokens: { total: turns }, toolCalls: 0 }
				: undefined;
	write({ ...response, data });
});
input.on("close", () => process.exit(0));
