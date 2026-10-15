// Synthetic RPC/account fixture. No provider, credentials, or network access.
import { appendFileSync, existsSync } from "node:fs";
import readline from "node:readline";

const mode = process.env.FAILED_REVIVAL_MODE;
const account = process.env.SYNTHETIC_ACCOUNT;
const first = account === "account-a";
const log = (kind, extra = {}) =>
	appendFileSync(process.env.FAILED_REVIVAL_LOG, `${JSON.stringify({ kind, pid: process.pid, account, ...extra })}\n`);
const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const assistant = (text, failed = false) => ({
	role: "assistant",
	api: "openai-responses",
	provider: "synthetic",
	model: "fixture",
	timestamp: 0,
	stopReason: failed ? "error" : "stop",
	errorMessage: failed ? text : undefined,
	content: [{ type: "text", text }],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const messages = [];
let failed = false;
let active = false;
const queue = [];
log("launch", { args: process.argv.slice(2) });

const finish = (text, isFailure = false) => {
	failed = isFailure;
	const message = assistant(text, isFailure);
	messages.push(message);
	write({ type: "message_start", message: assistant("") });
	write({ type: "message_end", message });
	write({ type: "agent_end", messages: [message] });
	write({ type: "agent_settled" });
	log("settled", { text, failed });
	active = false;
};
process.on("SIGUSR2", () => finish("synthetic quota exhausted", true));

const pump = () => {
	if (active || queue.length === 0) return;
	active = true;
	const text = queue.shift();
	write({ type: "agent_start" });
	if (first && text === "old request" && !mode.startsWith("healthy-idle") && !mode.startsWith("ambiguous")) return;
	if (first && (mode.startsWith("healthy-running") || mode.startsWith("stopped"))) return;
	setTimeout(() => {
		finish(
			!first && mode.startsWith("quota-again") ? "synthetic quota still exhausted" : `reply:${text}`,
			!first && mode.startsWith("quota-again"),
		);
		setTimeout(pump, 15);
	}, 80);
};
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const cmd = JSON.parse(line);
	const response = { type: "response", id: cmd.id, command: cmd.type, success: true };
	if (cmd.type === "prompt") {
		log("prompt", { message: cmd.message, streamingBehavior: cmd.streamingBehavior });
		if (!first && mode.startsWith("rejected-replacement")) {
			write({ ...response, success: false, error: "replacement preflight rejected" });
			return;
		}
		if (cmd.message === "ambiguous request") {
			// The work starts, but its acknowledgement is unusable. Replaying it
			// on another process would duplicate an already accepted user request.
			write({ type: "agent_start" });
			if (mode.startsWith("ambiguous-exit")) {
				log("accepted-without-ack");
				log("exit");
				process.exit(0);
			}
			write({ ...response, success: false, error: "acknowledgement lost after acceptance" });
			return;
		}
		const accept = () => {
			write({ ...response, data: { disposition: active ? "queued" : "started" } });
			queue.push(cmd.message);
			pump();
		};
		if (!first && mode.startsWith("concurrent-resume") && cmd.message === "new request") {
			log("preflight-held");
			const gate = setInterval(() => {
				if (existsSync(process.env.FAILED_REVIVAL_RESUME_RELEASE)) {
					clearInterval(gate);
					accept();
				}
			}, 5);
		} else accept();
		return;
	}
	if (cmd.type === "get_session_stats" && first && failed) {
		// Keep a real failed-yet-alive AgentProcess while completion metadata
		// is pending. Closing RPC during replacement releases this read.
		log("stats-held");
		return;
	}
	const data =
		cmd.type === "get_state"
			? { sessionFile: process.env.FAILED_REVIVAL_SESSION, sessionId: "saved" }
			: cmd.type === "get_messages"
				? { messages }
				: cmd.type === "get_last_assistant_text"
					? { text: messages.at(-1)?.content[0].text ?? "" }
					: cmd.type === "get_session_stats"
						? { tokens: { total: 0 }, toolCalls: 0 }
						: {};
	write({ ...response, data });
});
input.on("close", () => {
	log("closing");
	const exit = () => {
		log("exit");
		process.exit(0);
	};
	const releasePath = first ? process.env.FAILED_REVIVAL_RELEASE : process.env.FAILED_REVIVAL_REPLACEMENT_RELEASE;
	if ((!first && !mode.startsWith("rejected-replacement")) || existsSync(releasePath)) exit();
	else {
		const gate = setInterval(() => {
			if (existsSync(releasePath)) {
				clearInterval(gate);
				exit();
			}
		}, 5);
	}
});
