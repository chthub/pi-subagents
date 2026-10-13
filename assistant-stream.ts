/** Reconstruct delta-only RPC messages without exposing sparse arrays to pi's renderer. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

type WireUpdate = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];
type ContentBlock = AssistantMessage["content"][number];

/** Detached UI snapshot, retaining the wire indices hidden by dense rendering. */
export interface AssistantStreamSnapshot {
	message: AssistantMessage;
	contentIndices: number[];
}

export class AssistantStream {
	readonly message: AssistantMessage;
	/** Wire indices are stable even when earlier blocks have no visible content. */
	private readonly blocks = new Map<number, ContentBlock>();

	constructor(message: AssistantMessage, contentIndices?: readonly number[]) {
		this.message = structuredClone(message);
		this.message.content.forEach((block, index) => {
			if (block) this.blocks.set(contentIndices?.[index] ?? index, block);
		});
		this.syncContent();
	}

	/** Consumers may mutate this snapshot without changing the live fold. */
	snapshot(): AssistantStreamSnapshot {
		return {
			message: structuredClone(this.message),
			contentIndices: [...this.blocks.keys()].sort((a, b) => a - b),
		};
	}

	/** True when the renderer should update. Tool argument fragments are not displayed here. */
	apply(raw: unknown): boolean {
		if (!raw || typeof raw !== "object") return false;
		const event = raw as WireUpdate;
		if (!("contentIndex" in event) || !Number.isSafeInteger(event.contentIndex) || event.contentIndex < 0) return false;
		const index = event.contentIndex;
		const previous = this.blocks.get(index);
		let block: ContentBlock;
		switch (event.type) {
			case "text_start":
				block = previous?.type === "text" ? previous : { type: "text", text: "" };
				break;
			case "text_delta":
				if (typeof event.delta !== "string") return false;
				block = { ...(previous?.type === "text" ? previous : { type: "text" as const, text: "" }) };
				block.text += event.delta;
				break;
			case "text_end":
				if (typeof event.content !== "string") return false;
				block = { ...(previous?.type === "text" ? previous : { type: "text" as const }), text: event.content };
				break;
			case "thinking_start":
				block = previous?.type === "thinking" ? previous : { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				if (typeof event.delta !== "string") return false;
				block = { ...(previous?.type === "thinking" ? previous : { type: "thinking" as const, thinking: "" }) };
				block.thinking += event.delta;
				break;
			case "thinking_end":
				if (typeof event.content !== "string") return false;
				block = {
					...(previous?.type === "thinking" ? previous : { type: "thinking" as const }),
					thinking: event.content,
				};
				break;
			case "toolcall_start":
				if (typeof event.id !== "string" || typeof event.toolName !== "string") return false;
				block = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
				break;
			case "toolcall_end":
				if (event.toolCall?.type !== "toolCall") return false;
				block = structuredClone(event.toolCall);
				break;
			default:
				return false;
		}
		this.blocks.set(index, block);
		this.syncContent();
		return true;
	}

	private syncContent(): void {
		// Never use content[index] = block: skipped tool/empty blocks would leave
		// holes, and AssistantMessageComponent unconditionally reads block.type.
		this.message.content = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
	}
}
