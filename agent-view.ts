/**
 * pi-subagents — the agent view: one sub-agent's conversation, full screen.
 *
 * Opened from the bottom agent list (click) or /agents. Shows the child's
 * transcript with pi's own message components, streams its live turn, and
 * has an editor: ordinary messages are side chats; /continue resumes work
 * with its result reported to the parent. Ctrl+X twice stops a live
 * agent. Esc returns to the main conversation. A finished agent is revived
 * from its session file by the first message you send. Dragging over the
 * text selects it with pi's own fullscreen selection (copied on release).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KeybindingsManager, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	type TUI,
	type TuiAltScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { AgentFooter, type AgentFooterData } from "./agent-footer.js";
import { AssistantStream, type AssistantStreamSnapshot } from "./assistant-stream.js";
import type { RpcEvent } from "./protocol.js";
import { isTerminal, type RosterEntry } from "./roster.js";
import { buildTranscript, Transcript } from "./transcript.js";
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
	/** Current assistant fold for a late subscriber, including original wire indices. */
	streamingSnapshot?(): AssistantStreamSnapshot | undefined;
	/** The conversation so far: from the live child, else from the session file. */
	loadMessages(): Promise<unknown[]>;
	/** Deliver a message, reviving if needed. Parent-owned turns report their result up. */
	send(text: string, origin: "parent" | "user"): Promise<string | undefined>;
	/** Whether a live process is up to stop (not a nested telemetry row). */
	canStop?(): boolean;
	/** Stop the agent's process. Resolves an error text, or undefined. */
	stop?(): Promise<string | undefined>;
	/** pi's footer data for this agent (stats, model, its extensions' statuses). */
	footer?(): Promise<AgentFooterData | undefined>;
	/** Re-render the view when the roster changes. Returns the unsubscribe function. */
	onRosterChange(listener: () => void): () => void;
	renderers(toolName: string): ToolRenderers | undefined;
	cwd: string;
}

const HEADER_LINES = 3;
const STOP_KEY = Key.ctrl("x");

export class AgentView implements Component, Focusable {
	private _focused = false;
	private readonly editor: Editor;
	private readonly footer = new AgentFooter();
	private readonly spinner = new Spinner();
	private transcript = new Transcript();
	private disposed = false;
	private transcriptCache: { width: number; lines: string[] } | undefined;
	/** The live assistant turn, built from streamed deltas until message_end. */
	private streaming: { stream: AssistantStream; component: AssistantMessageComponent; ended: boolean } | undefined;
	/** Lines scrolled up from the bottom (0 = follow the end). */
	private scroll = 0;
	private viewport = 10;
	/** Geometry from the last render, in component-local terminal cells. */
	private scrollbar:
		| { x: number; y: number; height: number; thumbHeight: number; thumbTop: number; maxScroll: number }
		| undefined;
	private dragGrabOffset: number | undefined;
	private scrollbarHovered = false;
	/** A left button is down for pi's text selection: blank the rail so copies skip it. */
	private selecting = false;
	private expanded = false;
	private notice = "";
	private sending = false;
	/** The first Ctrl+X armed the stop; the second one confirms it. */
	private stopArmed = false;
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
		if (!value) {
			const active = this.scrollbarHovered || this.dragGrabOffset !== undefined;
			this.dragGrabOffset = undefined;
			this.scrollbarHovered = false;
			if (active) this.tui.requestRender();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.reloadSeq++;
		this.transcript.dispose();
		this.dragGrabOffset = undefined;
		this.scrollbarHovered = false;
		this.scrollbar = undefined;
		// The selection is in screen cells: it must not stay over the main conversation.
		this.resetSelection();
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
		this.dragGrabOffset = undefined;
		if (matchesKey(data, STOP_KEY)) {
			void this.requestStop();
			return;
		}
		if (this.stopArmed) {
			// Any other key cancels a pending stop confirmation.
			this.stopArmed = false;
			this.notice = "";
		}
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const rail = this.scrollbar;
		const wasActive = this.scrollbarHovered || this.dragGrabOffset !== undefined;
		this.scrollbarHovered =
			!!rail && rail.maxScroll > 0 && event.x === rail.x && event.y >= rail.y && event.y < rail.y + rail.height;
		if (event.type === "wheel" && event.wheelDelta) {
			this.dragGrabOffset = undefined;
			this.scrollBy(-event.wheelDelta);
			return { handled: true };
		}
		if (event.type === "release") {
			if (this.dragGrabOffset !== undefined) {
				this.dragGrabOffset = undefined;
				return { handled: true, render: wasActive !== this.scrollbarHovered };
			}
			// pi copies the selection from the current frame right after this
			// returns; the rail comes back on the next render.
			this.selecting = false;
			this.tui.requestRender();
			return undefined;
		}
		if (event.type === "drag") {
			if (this.dragGrabOffset === undefined) return undefined; // extends pi's text selection
			if (event.button === "left") this.scrollToPointer(event.y, this.dragGrabOffset);
			else this.dragGrabOffset = undefined;
			return { handled: true };
		}
		if (event.type === "press") {
			this.dragGrabOffset = undefined;
			if (event.button === "left" && rail && this.scrollbarHovered) {
				const row = event.y - rail.y;
				const onThumb = row >= rail.thumbTop && row < rail.thumbTop + rail.thumbHeight;
				this.dragGrabOffset = onThumb ? row - rail.thumbTop : Math.floor(rail.thumbHeight / 2);
				// Match native ScrollView: grab the thumb without jumping; a track
				// press centers it on the pointer, then continues as a drag.
				if (!onThumb) this.scrollToPointer(event.y, this.dragGrabOffset);
				return { handled: true, capture: true };
			}
			// Unhandled presses start pi's own text selection (an overlay hit never
			// reaches the main conversation underneath).
			this.selecting = event.button === "left";
			if (wasActive) this.tui.requestRender();
			return undefined;
		}
		// The synthetic click after a release must not jump again; handling it
		// also clears a click's empty selection.
		return { handled: true, render: wasActive !== (this.scrollbarHovered || this.dragGrabOffset !== undefined) };
	}

	/** Drop pi's fullscreen text selection: it marks screen cells, not conversation text. */
	private resetSelection(): void {
		this.selecting = false;
		(this.tui as Partial<Pick<TuiAltScreen, "resetTextSelection">>).resetTextSelection?.();
	}

	private scrollToPointer(y: number, grabOffset: number): void {
		const rail = this.scrollbar;
		if (!rail) return;
		const travel = rail.height - rail.thumbHeight;
		if (travel <= 0 || rail.maxScroll <= 0) return;
		const offset = Math.max(0, Math.min(travel, y - rail.y - Math.min(grabOffset, rail.thumbHeight - 1)));
		// The view stores distance from the bottom; the rail measures from top.
		this.scroll = rail.maxScroll - Math.round((offset / travel) * rail.maxScroll);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const rows = Math.max(8, this.tui.terminal.rows);
		const header = this.renderHeader(width);
		const editorLines = this.editor.render(width);
		// pi's own footer lines for this agent, then this view's key line last.
		const footerLines = this.footer.render(width);
		this.viewport = Math.max(3, rows - header.length - editorLines.length - footerLines.length - 1);

		// This overlay renders its own bounded viewport rather than exposing
		// a ScrollView layout node. Reserve one column for a visible scroll rail.
		const contentWidth = Math.max(1, width - 1);
		const body = [...this.transcriptLines(contentWidth), ...this.streamingLines(contentWidth)];
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
			if (
				this.scrollbar?.x !== width - 1 ||
				this.scrollbar.y !== header.length ||
				this.scrollbar.height !== this.viewport ||
				maxScroll === 0
			) {
				this.dragGrabOffset = undefined;
				this.scrollbarHovered = false;
			}
			this.scrollbar = { x: width - 1, y: header.length, height: this.viewport, thumbHeight, thumbTop, maxScroll };
			// Like native ScrollView, fill the cell on hover/drag instead of
			// changing the content width (which would rewrap text and move the rail).
			const thumbGlyph = this.scrollbarHovered || this.dragGrabOffset !== undefined ? "█" : "┃";
			for (let i = 0; i < visible.length; i++) {
				const thumb = i >= thumbTop && i < thumbTop + thumbHeight;
				visible[i] =
					truncateToWidth(visible[i], contentWidth, "", true) +
					(this.selecting ? " " : this.theme.fg(thumb ? "accent" : "borderMuted", thumb ? thumbGlyph : "│"));
			}
		} else {
			this.scrollbar = undefined;
			this.dragGrabOffset = undefined;
			this.scrollbarHovered = false;
		}
		const controls = this.renderControls(width);

		// Pad every line to the full width: the overlay must cover the main view.
		return [...header, ...visible, ...editorLines, ...footerLines, controls].map((line) =>
			truncateToWidth(line, width, "", true),
		);
	}

	// ── Data ───────────────────────────────────────────────

	/** (Re)subscribe to the live process — a revive brings a new one. */
	private attach(): void {
		if (this.disposed) return;
		const key = this.deps.processKey();
		if (key === this.attachedKey && this.unsubscribeEvents) return;
		this.unsubscribeEvents?.();
		this.attachedKey = key;
		this.streaming = undefined;
		this.unsubscribeEvents = this.deps.subscribe((event) => this.onEvent(event));
		const snapshot = this.deps.streamingSnapshot?.();
		if (snapshot) this.startStream(snapshot.message, snapshot.contentIndices);
	}

	private startStream(message: AssistantMessage, contentIndices?: readonly number[]): void {
		const stream = new AssistantStream(message, contentIndices);
		this.streaming = {
			stream,
			component: new AssistantMessageComponent(stream.message, false, getMarkdownTheme()),
			ended: false,
		};
	}

	private onRosterChange(): void {
		if (this.disposed) return;
		const key = this.deps.processKey();
		if (key !== this.attachedKey) {
			this.attach();
			void this.reload();
		}
		this.syncAnimation();
		this.tui.requestRender();
	}

	private async reload(): Promise<void> {
		if (this.disposed) return;
		const seq = ++this.reloadSeq;
		// Both load at once; a footer that cannot load must not cost the conversation.
		const footer = this.deps.footer?.().catch(() => undefined);
		let messages: unknown[] = [];
		try {
			messages = await this.deps.loadMessages();
		} catch (err) {
			if (!this.disposed && seq === this.reloadSeq) {
				this.notice = `Could not load the conversation: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		const footerData = footer && (await footer);
		if (seq !== this.reloadSeq) return; // a newer reload superseded this one
		this.footer.update(footerData);
		const transcript = buildTranscript(messages, {
			tui: this.tui,
			cwd: this.deps.entry()?.cwd ?? this.deps.cwd,
			renderers: (name) => this.deps.renderers(name),
			expanded: this.expanded,
		});
		this.transcript.dispose();
		this.transcript = transcript;
		this.transcriptCache = undefined;
		this.tui.requestRender();
	}

	/** Coalesce bursts (message_end + tool results) into one reload. */
	private scheduleReload(): void {
		if (this.disposed) return;
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = setTimeout(() => {
			this.reloadTimer = undefined;
			const live = this.streaming?.ended ? this.streaming : undefined;
			void this.reload().then(() => {
				if (this.disposed) return;
				// A slow replay must not erase a new turn or an unfinished stream.
				if (live && this.streaming === live) this.streaming = undefined;
				this.tui.requestRender();
			});
		}, 60);
	}

	private onEvent(event: RpcEvent): void {
		if (this.disposed) return;
		switch (event.type) {
			case "message_start": {
				const message = event.message as AssistantMessage | undefined;
				if (message?.role !== "assistant") return;
				this.startStream(message);
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
			case "extension_ui_request":
				// One of its extensions changed its footer status (read at render time).
				if (event.method === "setStatus") this.tui.requestRender();
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
		const continuation = /^\/continue(?:\s|$)/.test(text);
		const message = continuation
			? text.slice("/continue".length).trim() || "Continue the assigned task and return the result."
			: text;
		const entry = this.deps.entry();
		this.sending = true;
		this.notice = entry && isTerminal(entry.status) ? "Reviving…" : "Sending…";
		this.tui.requestRender();
		const error = await this.deps.send(message, continuation ? "parent" : "user");
		if (this.disposed) return;
		this.sending = false;
		const after = this.deps.entry();
		this.notice = error
			? error
			: continuation
				? "Result will be reported to parent"
				: after?.status === "running" && entry?.status === "running"
					? "Queued — delivered when the current turn ends"
					: "";
		this.scroll = 0;
		this.attach();
		this.tui.requestRender();
	}

	/** Ctrl+X arms, a second Ctrl+X stops: a stray key must not kill an agent's work. */
	private async requestStop(): Promise<void> {
		if (!this.deps.stop || !this.deps.canStop?.()) {
			this.stopArmed = false;
			this.notice = "Not running \u2014 nothing to stop";
			this.tui.requestRender();
			return;
		}
		if (!this.stopArmed) {
			this.stopArmed = true;
			this.notice = `Press Ctrl+X again to stop ${atId(this.deps.agentId)}`;
			this.tui.requestRender();
			return;
		}
		this.stopArmed = false;
		this.notice = "Stopping\u2026";
		this.tui.requestRender();
		const error = await this.deps.stop();
		if (this.disposed) return;
		this.notice = error ?? "Stopped \u2014 send a message to resume";
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
		this.resetSelection(); // the text under it moves
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
		const back = t.fg("dim", "Esc Back to main conversation");
		const title = ` ${glyph} ${t.fg("accent", t.bold(atId(this.deps.agentId)))} ${t.fg("bashMode", entry?.label ?? "")}  ${t.fg("muted", meta)}`;
		const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(back) - 1);
		const line1 =
			visibleWidth(title) + visibleWidth(back) + 2 <= width
				? `${title}${" ".repeat(gap)}${back}`
				: truncateToWidth(title, width, "…");
		const line2 = truncateToWidth(t.fg("dim", ` ${entry?.sessionPath ?? ""}`), width, "…");
		return [line1, line2, t.fg("borderMuted", "─".repeat(width))].slice(0, HEADER_LINES);
	}

	/** The view's own line: notices and its keys (the scrollbar shows the position). */
	private renderControls(width: number): string {
		const t = this.theme;
		const entry = this.deps.entry();
		const finished = entry ? isTerminal(entry.status) : true;
		const hint = finished ? "Finished — send a message to resume · " : "";
		const keys = `/continue Report to parent · Enter Side chat · ${this.deps.canStop?.() ? "Ctrl+X Stop · " : ""}PgUp/PgDn Scroll · Esc Back`;
		const notice = this.notice ? `${this.notice} · ` : "";
		return truncateToWidth(t.fg("dim", `${notice}${hint}${keys}`), width, "…");
	}
}
