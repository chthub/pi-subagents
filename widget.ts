/**
 * pi-subagents — the bottom agent list.
 *
 * One line per sub-agent of this conversation, live or finished, below the
 * editor: `⠋ @jude  label  12s  bash: ls -la`. Clicking a line (fullscreen
 * mouse mode) opens that agent's view; `/agents` is the keyboard path.
 *
 * The list renders the Roster. AgentWidget is also the adapter the registry
 * and tree telemetry write through (add / addNested / remove / setStatus /
 * updateActivity) — a removed agent keeps its row with a terminal status
 * instead of disappearing.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentProcess } from "./agent-process.js";
import type { AgentActivity } from "./event-interpret.js";
import { isTerminal, type Roster, type RosterActivity, type RosterEntry, type RosterStatus } from "./roster.js";
import { formatElapsed, SPINNER_TICK_MS, Spinner } from "./ui/spinner.js";
import { type TickerHandle, ticker } from "./ui/ticker.js";
import type { WidgetResult, WidgetRow, WidgetStatus } from "./ui/widget.js";
import { atId } from "./views.js";

const WIDGET_KEY = "pi-subagents-list";
/** Agent lines shown before the rest fold into a `+N more` line. */
const MAX_LINES = 8;

interface MouseEventLite {
	type: string;
	button: string;
	y: number;
	screenY?: number;
}

/** One SGR mouse report (`ESC [ < b ; x ; y M|m`); group 1 = the 1-based row. */
const SGR_MOUSE = new RegExp(`${String.fromCharCode(27)}\\[<\\d+;\\d+;(\\d+)[Mm]`, "g");

export class AgentWidget {
	private registered = false;
	private tui: { requestRender(): void } | undefined;
	private animation: TickerHandle | undefined;
	private readonly spinner = new Spinner();
	/** Rendered line index → agent id (click targets of the last render). */
	private lineAgents: (string | undefined)[] = [];
	private readonly unsubscribe: () => void;
	/** Agent line under the pointer (fullscreen mode reports pointer motion). */
	private hovered: string | undefined;
	/** Where the list sat on screen at the last pointer event it received. */
	private screenTop: number | undefined;
	private readonly unsubscribeInput: () => void;

	constructor(
		private readonly ui: ExtensionUIContext,
		private readonly roster: Roster,
		private readonly onOpen: (agentId: string) => void,
	) {
		this.unsubscribe = roster.onChange(() => this.reconcile());
		// pi has no pointer-leave event: watch raw mouse reports and drop the
		// hover once the pointer is outside the rows the list occupies.
		this.unsubscribeInput =
			typeof ui.onTerminalInput === "function" ? ui.onTerminalInput((data) => this.watchPointer(data)) : () => {};
		this.reconcile();
	}

	/** Track a local agent (background, resident, or revived). */
	add(agent: AgentProcess, status: "running" | "idle" = "running"): void {
		this.roster.upsert({
			agentId: agent.agentId,
			label: agent.label,
			startedAt: agent.startedAt,
			status,
			sessionPath: agent.sessionPath,
			model: agent.model,
			indent: 0,
		});
	}

	/** Track a nested agent (tree telemetry from a descendant's own spawns). */
	addNested(agent: {
		agentId: string;
		label: string;
		startedAt: number;
		indent: number;
		status: "running" | "idle";
		parentId?: string;
	}): void {
		this.roster.upsert({ ...agent });
	}

	/** The agent ended: its row stays, with the terminal status. */
	remove(agentId: string, result?: WidgetResult): void {
		this.roster.setStatus(agentId, result ?? "stopped");
	}

	setStatus(agentId: string, status: WidgetStatus): void {
		this.roster.setStatus(agentId, status);
	}

	updateActivity(agentId: string, activity: AgentActivity | undefined): void {
		this.roster.setActivity(agentId, activityToRows(activity)[0]);
	}

	/** Unregister the widget (session shutdown). The roster is owned by the caller. */
	dispose(): void {
		this.unsubscribe();
		this.unsubscribeInput();
		this.stopAnimation();
		if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
		this.registered = false;
		this.tui = undefined;
	}

	// ── Internal ───────────────────────────────────────────

	private reconcile(): void {
		const entries = this.roster.list();
		if (entries.length === 0) {
			this.stopAnimation();
			if (this.registered) this.ui.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
			return;
		}
		this.register();
		// The clock runs only while something is running (spinner + elapsed).
		if (entries.some((e) => e.status === "running")) {
			this.animation ??= ticker.subscribe(() => this.tui?.requestRender(), SPINNER_TICK_MS);
		} else {
			this.stopAnimation();
		}
		this.tui?.requestRender();
	}

	private stopAnimation(): void {
		this.animation?.unsubscribe();
		this.animation = undefined;
	}

	private register(): void {
		if (this.registered) return;
		this.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui as { requestRender(): void };
				return {
					render: (width: number) => this.render(theme, width),
					invalidate: () => {},
					handleMouse: (event: MouseEventLite) => this.handleMouse(event),
				};
			},
			{ placement: "belowEditor" },
		);
		this.registered = true;
	}

	private handleMouse(event: MouseEventLite): { handled: boolean } | undefined {
		const agentId = this.lineAgents[event.y];
		if (event.screenY !== undefined) this.screenTop = event.screenY - event.y;
		if (event.type === "move") {
			this.setHovered(agentId);
			return undefined; // motion stays available to the renderer
		}
		if (event.type !== "click" || event.button !== "left" || !agentId) return undefined;
		this.setHovered(undefined);
		this.onOpen(agentId);
		return { handled: true };
	}

	private setHovered(agentId: string | undefined): void {
		if (agentId === this.hovered) return;
		this.hovered = agentId;
		this.tui?.requestRender();
	}

	private watchPointer(data: string): undefined {
		if (this.hovered === undefined || this.screenTop === undefined) return undefined;
		for (const match of data.matchAll(SGR_MOUSE)) {
			const row = Number(match[1]) - 1;
			if (row < this.screenTop || row >= this.screenTop + this.lineAgents.length) this.setHovered(undefined);
		}
		return undefined;
	}

	private render(theme: Theme, width: number): string[] {
		const { shown, hidden } = pickVisible(this.roster.list(), MAX_LINES);
		const idWidth = Math.max(...shown.map((e) => visibleWidth(atId(e.agentId))));
		const lines: string[] = [];
		this.lineAgents = [];
		for (const entry of shown) {
			const hovered = entry.agentId === this.hovered;
			lines.push(renderAgentLine(entry, theme, this.spinner, idWidth, width, hovered));
			this.lineAgents.push(entry.indent === 0 || entry.sessionPath ? entry.agentId : undefined);
		}
		const tail = hidden > 0 ? `… +${hidden} more · /agents` : "点击进入 · /agents";
		lines.push(truncateToWidth(theme.fg("dim", ` ${tail}`), width, ""));
		this.lineAgents.push(undefined);
		return lines;
	}
}

/** Which entries get a line: all of them when they fit; otherwise live agents
 *  first, then the most recently finished — shown in spawn order. */
export function pickVisible(entries: RosterEntry[], max: number): { shown: RosterEntry[]; hidden: number } {
	if (entries.length <= max) return { shown: entries, hidden: 0 };
	const live = entries.filter((e) => !isTerminal(e.status));
	const finished = entries.filter((e) => isTerminal(e.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	const keep = new Set([...live, ...finished].slice(0, max));
	return { shown: entries.filter((e) => keep.has(e)), hidden: entries.length - keep.size };
}

const STATUS_ICON: Record<
	RosterStatus,
	{ glyph: string; color: "accent" | "muted" | "success" | "error" | "warning" }
> = {
	running: { glyph: "", color: "accent" },
	idle: { glyph: "‖", color: "muted" },
	done: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	stopped: { glyph: "■", color: "warning" },
};

function statusMeta(entry: RosterEntry): string {
	switch (entry.status) {
		case "running":
			return formatElapsed(Date.now() - entry.startedAt);
		case "done":
			return entry.endedAt !== undefined ? formatElapsed(entry.endedAt - entry.startedAt) : "done";
		default:
			return entry.status;
	}
}

/** `<indent> ⠋ @id  label  meta  activity` — always exactly fits `width`.
 *  A hovered line gets a `▸` marker, an underlined label and the selection
 *  background across the full width. */
export function renderAgentLine(
	entry: RosterEntry,
	theme: Theme,
	spinner: Spinner,
	idWidth: number,
	width: number,
	hovered = false,
): string {
	const line = plainAgentLine(entry, theme, spinner, idWidth, width, hovered);
	return hovered ? withBackground(line, width, theme) : line;
}

function plainAgentLine(
	entry: RosterEntry,
	theme: Theme,
	spinner: Spinner,
	idWidth: number,
	width: number,
	hovered: boolean,
): string {
	const icon = STATUS_ICON[entry.status];
	const glyph = entry.status === "running" ? spinner.current() : icon.glyph;
	const id = atId(entry.agentId);
	const marker = hovered ? theme.fg("accent", "\u25b8") : " ";
	const prefix = `${"  ".repeat(entry.indent)}${marker}${theme.fg(icon.color, glyph)} ${theme.fg("accent", id)}${" ".repeat(Math.max(0, idWidth - visibleWidth(id)))}  `;
	const meta = statusMeta(entry);
	const metaStyled = theme.fg(entry.status === "failed" ? "error" : "muted", meta);
	let room = width - visibleWidth(prefix) - visibleWidth(meta) - 2;
	if (room < 4) return truncateToWidth(prefix + metaStyled, width, "");

	const activity = entry.activity ? flatten(entry.activity.content) : "";
	// The label gets what it needs up to half the room when an activity
	// excerpt competes for it, and all of it otherwise.
	const labelRoom = activity ? Math.max(8, Math.min(visibleWidth(entry.label), Math.floor(room / 2))) : room;
	const label = truncateToWidth(flatten(entry.label), labelRoom, "…");
	const labelPad = " ".repeat(Math.max(0, Math.min(visibleWidth(entry.label), labelRoom) - visibleWidth(label)));
	const labelStyled = theme.fg("bashMode", hovered ? theme.underline(label) : label);
	let line = `${prefix}${labelStyled}${labelPad}  ${metaStyled}`;
	room -= visibleWidth(label) + visibleWidth(labelPad);
	if (activity && room > 6) {
		// Keep the tail of streamed text (the newest words), the head of a tool call.
		const text =
			entry.activity?.style === "text" && visibleWidth(activity) > room - 2
				? `…${activity.slice(-(room - 3))}`
				: activity;
		line += `  ${theme.fg(entry.activity?.style === "thinking" ? "thinkingText" : "dim", truncateToWidth(text, room - 2, "…"))}`;
	}
	return truncateToWidth(line, width, "");
}

/** Paint the selection background across the whole line. Styled segments end
 *  in full resets, so the background is reopened after each one. */
function withBackground(line: string, width: number, theme: Theme): string {
	const open = theme.bg("selectedBg", "\u0000").split("\u0000")[0] ?? "";
	const padded = truncateToWidth(line, width, "", true);
	return `${open}${padded.replaceAll("\x1b[0m", `\x1b[0m${open}`)}\x1b[0m`;
}

function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Map the latest activity to structured rows (pure data, not formatted).
 *  Tool args are flattened to one line; streamed text passes through. */
export function activityToRows(activity: AgentActivity | undefined): WidgetRow[] {
	if (!activity) return [];
	if (activity.kind === "thinking") return [{ style: "thinking", content: "Thinking..." }];
	if (activity.kind === "tool")
		return [{ style: "tool", content: `${activity.name}: ${activity.args.replace(/\s+/g, " ")}` }];
	return [{ style: "text", content: activity.text }];
}

export type { RosterActivity };
