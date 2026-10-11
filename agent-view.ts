/**
 * pi-subagents — the agent view: one sub-agent's conversation, full screen.
 *
 * Opened from the bottom agent list (click) or /agents. Shows the child's
 * transcript with pi's own message components, streams its live turn, and
 * has an editor: what you type goes to that agent (a side chat — its
 * answers are not reported to the main agent). Esc returns to the main
 * conversation. A finished agent is revived from its session file by the
 * first message you send.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { AssistantStream } from "./assistant-stream.js";
import type { RpcEvent } from "./protocol.js";
import { isTerminal, type RosterEntry } from "./roster.js";
import { buildTranscript } from "./transcript.js";
import { formatDuration, SPINNER_TICK_MS, Spinner } from "./ui/spinner.js";
import { type TickerHandle, ticker } from "./ui/ticker.js";
import { atId } from "./views.js";

/** What the view needs from the extension (no registry or pi API here). */
export interface AgentViewDeps {
	agentId: string;
	/** Live roster entry (status, label, session path…). */
	entry(): RosterEntry | undefined;
	/** Subscribe to the live child's rpc events; undefined when no process is up. */
	subscribe(listener: (event: RpcEvent) => void): (() => void) | undefined;
	/** Identity of the live process (changes when the agent is revived). */
	processKey(): unknown;
	/** The conversation so far: from the live child, else from the session file. */
	loadMessages(): Promise<unknown[]>;
	/** Deliver a user message (reviving a finished agent). Resolves an error text, or undefined. */
	send(text: string): Promise<string | undefined>;
	/** Re-render the view when the roster changes. Returns the unsubscribe function. */
	onRosterChange(listener: () => void): () => void;
	renderers(toolName: string): ToolRenderers | undefined;
	cwd: string;
}

const HEADER_LINES = 3;

export class AgentView implements Component, Focusable {
	private _focused = false;
	private readonly editor: Editor;
	private readonly spinner = new Spinner();
	private transcript: Container = new Container();
	private transcriptCache: { width: number; lines: string[] } | undefined;
	/** The live assistant turn, built from streamed deltas until message_end. */
	private streaming: { stream: AssistantStream; component: AssistantMessageComponent; ended: boolean } | undefined;
	/** Lines scrolled up from the bottom (0 = follow the end). */
	private scroll = 0;
	private viewport = 10;
	private contentHeight = 0;
	private expanded = false;
	private notice = "";
	private sending = false;
	private reloadTimer: NodeJS.Timeout | undefined;
	private reloadSeq = 0;
	private unsubscribeEvents: (() => void) | undefined;
	private attachedKey: unknown;
	private readonly unsubscribeRoster: () => void;
	private animation: TickerHandle | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly deps: AgentViewDeps,
		private readonly done: () => void,
	) {
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onSubmit = (text) => void this.submit(text);
		this.unsubscribeRoster = deps.onRosterChange(() => this.onRosterChange());
		this.attach();
		void this.reload();
		this.syncAnimation();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value; // IME candidate window follows the editor cursor
	}

	dispose(): void {
		this.unsubscribeEvents?.();
		this.unsubscribeRoster();
		this.animation?.unsubscribe();
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
	}

	invalidate(): void {
		this.transcriptCache = undefined;
		this.transcript.invalidate();
		this.streaming?.component.invalidate();
		this.editor.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.expanded = !this.expanded;
			void this.reload();
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(Math.max(1, this.viewport - 2));
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(-Math.max(1, this.viewport - 2));
			return;
		}
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: { type: string; wheelDelta?: number }): { handled: boolean } | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return { handled: true };
		this.scrollBy(-event.wheelDelta);
		return { handled: true };
	}

	render(width: number): string[] {
		const rows = Math.max(8, this.tui.terminal.rows);
		const header = this.renderHeader(width);
		const editorLines = this.editor.render(width);
		this.viewport = Math.max(3, rows - header.length - editorLines.length - 1);

		// This overlay renders its own bounded viewport rather than exposing
		// a ScrollView layout node. Reserve one column for a visible scroll rail.
		const contentWidth = Math.max(1, width - 1);
		const body = [...this.transcriptLines(contentWidth), ...this.streamingLines(contentWidth)];
		this.contentHeight = body.length;
		const maxScroll = Math.max(0, body.length - this.viewport);
		this.scroll = Math.min(this.scroll, maxScroll);
		const end = body.length - this.scroll;
		const visible = body.slice(Math.max(0, end - this.viewport), end);
		while (visible.length < this.viewport) visible.unshift("");
		if (width > 1) {
			const thumbHeight = Math.max(
				2,
				Math.min(this.viewport, Math.round(this.viewport ** 2 / Math.max(1, body.length))),
			);
			const thumbTop = maxScroll
				? Math.round(((maxScroll - this.scroll) / maxScroll) * (this.viewport - thumbHeight))
				: 0;
			for (let i = 0; i < visible.length; i++) {
				const thumb = i >= thumbTop && i < thumbTop + thumbHeight;
				visible[i] =
					truncateToWidth(visible[i], contentWidth, "", true) +
					this.theme.fg(thumb ? "accent" : "borderMuted", thumb ? "┃" : "│");
			}
		}
		const footer = [this.renderFooter(width)];

		// Pad every line to the full width: the overlay must cover the main view.
		return [...header, ...visible, ...editorLines, ...footer].map((line) => truncateToWidth(line, width, "", true));
	}

	// ── Data ───────────────────────────────────────────────

	/** (Re)subscribe to the live process — a revive brings a new one. */
	private attach(): void {
		const key = this.deps.processKey();
		if (key === this.attachedKey && this.unsubscribeEvents) return;
		this.unsubscribeEvents?.();
		this.attachedKey = key;
		this.unsubscribeEvents = this.deps.subscribe((event) => this.onEvent(event));
	}

	private onRosterChange(): void {
		const key = this.deps.processKey();
		if (key !== this.attachedKey) {
			this.attach();
			void this.reload();
		}
		this.syncAnimation();
		this.tui.requestRender();
	}

	private async reload(): Promise<void> {
		const seq = ++this.reloadSeq;
		let messages: unknown[] = [];
		try {
			messages = await this.deps.loadMessages();
		} catch (err) {
			this.notice = `Could not load the conversation: ${err instanceof Error ? err.message : String(err)}`;
		}
		if (seq !== this.reloadSeq) return; // a newer reload superseded this one
		this.transcript = buildTranscript(messages, {
			tui: this.tui,
			cwd: this.deps.entry()?.cwd ?? this.deps.cwd,
			renderers: (name) => this.deps.renderers(name),
			expanded: this.expanded,
		});
		this.transcriptCache = undefined;
		this.tui.requestRender();
	}

	/** Coalesce bursts (message_end + tool results) into one reload. */
	private scheduleReload(): void {
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined;
			const live = this.streaming?.ended ? this.streaming : undefined;
			void this.reload().then(() => {
				// A slow replay must not erase a new turn or an unfinished stream.
				if (live && this.streaming === live) this.streaming = undefined;
				this.tui.requestRender();
			});
		}, 60);
	}

	private onEvent(event: RpcEvent): void {
		switch (event.type) {
			case "message_start": {
				const message = event.message as AssistantMessage | undefined;
				if (message?.role !== "assistant") return;
				const stream = new AssistantStream(message);
				this.streaming = {
					stream,
					component: new AssistantMessageComponent(stream.message, false, getMarkdownTheme()),
					ended: false,
				};
				this.tui.requestRender();
				return;
			}
			case "message_update":
				this.applyDelta(event.assistantMessageEvent);
				return;
			case "message_end": {
				const message = event.message as AssistantMessage | undefined;
				if (message?.role === "assistant" && this.streaming) {
					this.streaming.stream = new AssistantStream(message);
					this.streaming.ended = true;
					this.streaming.component.updateContent(this.streaming.stream.message, false);
					this.tui.requestRender();
				}
				this.scheduleReload();
				return;
			}
			case "tool_execution_end":
			case "agent_end":
				this.scheduleReload();
				return;
		}
	}

	/** Fold one wire content-block event into a dense live assistant message. */
	private applyDelta(delta: unknown): void {
		const live = this.streaming;
		if (!live || live.ended || !live.stream.apply(delta)) return;
		live.component.updateContent(live.stream.message, true);
		this.tui.requestRender();
	}

	private async submit(raw: string): Promise<void> {
		const text = raw.trim();
		if (!text || this.sending) return;
		this.editor.addToHistory(text);
		this.editor.setText("");
		const entry = this.deps.entry();
		this.sending = true;
		this.notice = entry && isTerminal(entry.status) ? "Reviving…" : "Sending…";
		this.tui.requestRender();
		const error = await this.deps.send(text);
		this.sending = false;
		const after = this.deps.entry();
		this.notice = error
			? error
			: after?.status === "running" && entry?.status === "running"
				? "Queued — delivered when the current turn ends"
				: "";
		this.scroll = 0;
		this.attach();
		this.tui.requestRender();
	}

	// ── Rendering ──────────────────────────────────────────

	private syncAnimation(): void {
		const running = this.deps.entry()?.status === "running";
		if (running && !this.animation) {
			this.animation = ticker.subscribe(() => this.tui.requestRender(), SPINNER_TICK_MS);
		} else if (!running && this.animation) {
			this.animation.unsubscribe();
			this.animation = undefined;
		}
	}

	private scrollBy(lines: number): void {
		this.scroll = Math.max(0, this.scroll + lines);
		this.tui.requestRender();
	}

	private transcriptLines(width: number): string[] {
		if (this.transcriptCache?.width !== width) {
			this.transcriptCache = { width, lines: this.transcript.render(width) };
		}
		return this.transcriptCache.lines;
	}

	private streamingLines(width: number): string[] {
		const entry = this.deps.entry();
		const lines = this.streaming ? this.streaming.component.render(width) : [];
		if (entry?.status === "running") {
			const activity = entry.activity ? ` ${entry.activity.content.replace(/\s+/g, " ")}` : "";
			lines.push(
				"",
				truncateToWidth(
					` ${this.theme.fg("accent", this.spinner.current())}${this.theme.fg("dim", ` Working…${activity}`)}`,
					width,
					"…",
				),
			);
		}
		return lines;
	}

	private renderHeader(width: number): string[] {
		const t = this.theme;
		const entry = this.deps.entry();
		const status = entry?.status ?? "done";
		const glyph =
			status === "running"
				? t.fg("accent", this.spinner.current())
				: status === "idle"
					? t.fg("muted", "‖")
					: status === "failed"
						? t.fg("error", "✗")
						: status === "stopped"
							? t.fg("warning", "■")
							: t.fg("success", "✓");
		const elapsed = status === "running" && entry ? formatDuration(Date.now() - entry.startedAt) : status;
		const meta = [elapsed, entry?.model, entry?.tools?.length ? `tools: ${entry.tools.join(", ")}` : undefined]
			.filter(Boolean)
			.join(" · ");
		const back = t.fg("dim", "Esc 返回主对话");
		const title = ` ${glyph} ${t.fg("accent", t.bold(atId(this.deps.agentId)))} ${t.fg("bashMode", entry?.label ?? "")}  ${t.fg("muted", meta)}`;
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(back) - 1);
		const line1 =
			visibleWidth(title) + visibleWidth(back) + 2 <= width
				? `${title}${" ".repeat(gap)}${back}`
				: truncateToWidth(title, width, "…");
		const line2 = truncateToWidth(t.fg("dim", ` ${entry?.sessionPath ?? ""}`), width, "…");
		return [line1, line2, t.fg("borderMuted", "─".repeat(width))].slice(0, HEADER_LINES);
	}

	private renderFooter(width: number): string {
		const t = this.theme;
		const entry = this.deps.entry();
		const finished = entry ? isTerminal(entry.status) : true;
		const hint = finished ? "已结束 — 发消息会复活它 · " : "";
		const keys = "Enter 发送 · PgUp/PgDn 滚动 · Esc 返回";
		const notice = this.notice ? `${this.notice} · ` : "";
		const end = this.contentHeight - this.scroll;
		const position =
			this.contentHeight > this.viewport
				? `${Math.max(1, end - this.viewport + 1)}–${end}/${this.contentHeight} · `
				: "";
		return truncateToWidth(t.fg("dim", ` ${position}${notice}${hint}${keys} · 不会通知主 agent`), width, "…");
	}
}
