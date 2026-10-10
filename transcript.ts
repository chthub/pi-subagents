/**
 * pi-subagents — render a child conversation with pi's own components.
 *
 * A port of the interactive mode's session replay (renderSessionItems /
 * addMessageToChat) onto the components pi exports, so the agent view looks
 * like the main transcript: user messages, assistant messages, tool calls
 * matched with their results, and displayed custom messages.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	getMarkdownTheme,
	ToolExecutionComponent,
	type ToolRenderers,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { dataCard, textLine } from "./ui/card.js";

/** Structural subset of pi's AgentMessage that the replay reads. */
interface ReplayMessage {
	role: string;
	content?: unknown;
	toolCallId?: string;
	isError?: boolean;
	details?: unknown;
	display?: boolean;
	stopReason?: string;
	errorMessage?: string;
}

export interface TranscriptOptions {
	tui: TUI;
	cwd: string;
	/** Renderers for a tool name (pi's built-ins when known), or undefined for the default card. */
	renderers: (toolName: string) => ToolRenderers | undefined;
	expanded: boolean;
}

/** The text of a user message (string content or its text blocks). */
export function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** One container holding the whole replayed conversation. */
export function buildTranscript(messages: readonly unknown[], opts: TranscriptOptions): Container {
	const chat = new Container();
	const markdownTheme = getMarkdownTheme();
	const pending = new Map<string, ToolExecutionComponent>();
	const add = (component: Component) => chat.addChild(component);

	for (const raw of messages) {
		const message = raw as ReplayMessage;
		switch (message.role) {
			case "user": {
				const text = userText(message.content);
				if (!text) break;
				if (chat.children.length > 0) add(new Spacer(1));
				add(new UserMessageComponent(text, markdownTheme));
				break;
			}
			case "assistant": {
				add(new AssistantMessageComponent(message as unknown as AssistantMessage, false, markdownTheme));
				const failed = message.stopReason === "aborted" || message.stopReason === "error";
				for (const block of (message.content ?? []) as {
					type?: string;
					id?: string;
					name?: string;
					arguments?: unknown;
				}[]) {
					if (block.type !== "toolCall" || !block.id || !block.name) continue;
					const component = new ToolExecutionComponent(
						block.name,
						block.id,
						block.arguments ?? {},
						{ showImages: false },
						opts.renderers(block.name),
						opts.tui,
						opts.cwd,
					);
					component.setExpanded(opts.expanded);
					add(component);
					if (failed) {
						const text = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
						component.updateResult({ content: [{ type: "text", text }], isError: true });
					} else {
						pending.set(block.id, component);
					}
				}
				break;
			}
			case "toolResult": {
				const component = message.toolCallId ? pending.get(message.toolCallId) : undefined;
				if (!component) break;
				component.updateResult({
					content: (message.content ?? []) as { type: string; text?: string }[],
					details: message.details,
					isError: message.isError ?? false,
				});
				pending.delete(message.toolCallId as string);
				break;
			}
			case "custom": {
				if (!message.display) break;
				const component = new CustomMessageComponent(message as never, undefined, markdownTheme);
				component.setExpanded(opts.expanded);
				add(component);
				break;
			}
		}
	}
	return chat;
}

/** The argument that identifies a call, per tool (`$ cmd`, a path, a pattern). */
function callTitle(toolName: string, args: Record<string, unknown>): string {
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	if (toolName === "bash" || toolName === "powershell") {
		const command = str(args.command) ?? "";
		return `${toolName === "bash" ? "$" : "PS>"} ${command.replace(/\s*\n\s*/g, " \u21b5 ")}`;
	}
	const named = str(args.path) ?? str(args.file_path) ?? str(args.pattern) ?? str(args.query) ?? str(args.url);
	if (named) return named;
	const compact = JSON.stringify(args);
	return compact === "{}" ? "" : compact;
}

/**
 * Renderers for a tool the main transcript has not resolved yet (pi's own
 * built-in renderers are not exported): `name title` header, then the output
 * folded like bash (tail preview, ctrl+o expands).
 */
export function fallbackRenderers(toolName: string): ToolRenderers {
	return {
		renderCall: (args, theme) => {
			const title = callTitle(toolName, (args ?? {}) as Record<string, unknown>);
			return textLine(
				`${theme.fg("toolTitle", theme.bold(toolName))}${title ? ` ${theme.fg("bashMode", title)}` : ""}`,
			);
		},
		renderResult: (result, options, theme, context) => {
			const text = userText(result.content);
			return dataCard(
				{
					status: context.isError ? "error" : "success",
					name: toolName,
					body: text || undefined,
					expanded: options.expanded,
					bare: true,
				},
				theme,
			);
		},
	};
}
