/**
 * pi-subagent — tool card views (single source of truth).
 *
 * The three card templates (agent_spawn / agent_stop / agent_send) live here
 * so production (index.ts registration) and the dev preview (preview.ts)
 * render the exact same cards — no mirrored copies to drift.
 *
 * Pure rendering: no pi API, no registry — only the ToolRenderContext shape.
 */

import type { SubagentDetails } from "./types.js";
import type { CardField } from "./ui/card.js";
import { durationMeta, formatDuration } from "./ui/spinner.js";
import { createToolView } from "./ui/view.js";
import { counterParts } from "./ui/widget.js";

/** Add "@" exactly once — ids may already carry it ("@parent", "@max").
 * Display layers must go through this so the literal @-form never doubles
 * into "@@parent". */
export function atId(id: string): string {
	return id.startsWith("@") ? id : `@${id}`;
}

/** Row/card identity for a spawned agent: `@id — label` — the user matches
 *  the @name the LLM mentions in chat. Widget rows and notification cards
 *  both go through this (one title, one spelling). The @-prefix goes
 *  through atId so an id that already carries one never doubles. */
export function agentTitle(agentId: string, label: string): string {
	return `${atId(agentId)} — ${label}`;
}

/**
 * Card title for agent_stop / agent_send: the target's label when the result
 * carried one, else the at-prefixed target id, else from args. The `@id —
 * label` join goes through agentTitle (one title, one spelling).
 */
export function titleFrom(ctx: { result?: { data?: unknown }; args?: unknown }, idKey: string): string {
	const data = (ctx.result?.data as ({ label?: string } & Record<string, unknown>) | undefined) ?? {};
	const args = ctx.args as Record<string, unknown> | undefined;
	const id = data[idKey] ?? args?.[idKey];
	const label = data.label;
	if (id && label) return agentTitle(String(id), label);
	return label ?? (id ? atId(String(id)) : "");
}

/** agent_spawn arguments as the LLM wrote them (any field may be missing while streaming). */
interface SpawnArgs {
	prompt?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	run_in_background?: boolean;
	persistent?: boolean;
	timeoutMs?: number;
}

/** Collapsed prompt cap (visual lines) — the write card's head preview size. */
const PROMPT_FOLD_LINES = 10;

/**
 * The call record on the spawn card: every argument as the LLM wrote it,
 * with what the mechanism resolved it to (inherited model/thinking, the
 * default mode, the full model id) — so the user can audit the call.
 */
export function spawnFields(args: unknown, d: SubagentDetails | undefined): CardField[] {
	const a = (args ?? {}) as SpawnArgs;
	const fields: CardField[] = [];
	if (d?.agentId) fields.push({ key: "agent", value: atId(d.agentId) });

	const background = d?.runInBackground ?? a.run_in_background;
	const persistent = d?.persistent ?? a.persistent;
	const mode = [
		background === undefined ? undefined : background ? "background" : "foreground",
		persistent ? "persistent" : undefined,
		a.timeoutMs ? `timeout ${formatDuration(a.timeoutMs)}` : undefined,
	].filter((m): m is string => m !== undefined);
	const defaulted =
		(a.run_in_background === undefined && background !== undefined) ||
		(a.persistent === undefined && persistent !== undefined);
	if (mode.length > 0)
		fields.push({ key: "mode", value: mode.join(" \u00b7 "), note: defaulted ? "(default)" : undefined });

	fields.push(resolvedField("model", a.model, d?.model));
	fields.push(resolvedField("thinking", a.thinking, d?.thinking));
	fields.push(
		a.tools?.length ? { key: "tools", value: a.tools.join(", ") } : { key: "tools", value: "all", note: "(default)" },
	);
	if (a.prompt) fields.push({ key: "prompt", value: a.prompt, fold: PROMPT_FOLD_LINES });
	return fields;
}

/** `written → resolved`, or the inherited value when the argument was omitted. */
function resolvedField(key: string, written: string | undefined, resolved: string | undefined): CardField {
	if (!written) return resolved ? { key, value: resolved, note: "(inherited)" } : { key, value: "inherited" };
	if (resolved && resolved !== written) return { key, value: `${written} \u2192 ${resolved}` };
	return { key, value: written };
}

export const spawnView = createToolView<Record<string, unknown>, SubagentDetails>({
	name: "agent_spawn",
	title: (ctx) => {
		const d = ctx.result?.data;
		return String((ctx.args as { label?: unknown }).label ?? d?.label ?? d?.task ?? "");
	},
	tail: (ctx) => {
		if (ctx.status === "error") return "start failed";
		if (ctx.status === "processing") {
			// starting… while nothing has streamed yet, working… once the
			// agent is actually producing activity.
			const d = ctx.result?.data;
			return d?.events?.length ? "working\u2026" : "starting\u2026";
		}
		// Completed: "started" is a background spawn (task keeps running,
		// tracked by the widget); a foreground agent is simply done.
		const d = ctx.result?.data;
		return d?.runInBackground ? "started" : "done";
	},
	// Model and thinking live in the call record below — the header keeps
	// only what changes: duration and the nested-subtree counters.
	meta: (ctx) => {
		const d = ctx.result?.data;
		const parts: string[] = [];
		// Duration meta: live Elapsed while running, fixed Took on completion;
		// a background spawn has no duration (the widget tracks it live).
		if (d?.startedAt != null) {
			if (!d.runInBackground) {
				const dur = durationMeta(ctx.status, d.startedAt, d.endedAt);
				if (dur) parts.push(dur);
			}
		}
		// Nested-subtree summary (foreground cards): the whole descendant
		// tree of this agent folded into one count set — the shared counter
		// vocabulary (pi-ui counterParts; SPEC: 显示面统一规则).
		const n = d?.nested;
		if (n && n.total > 0) {
			parts.push(...counterParts(n).map((p) => p.text));
		}
		return parts;
	},
	// The call record (prompt included) sits above the activity stream and
	// never scrolls out with it.
	fields: (ctx) => spawnFields(ctx.args, ctx.result?.data),
	body: {
		rows: {
			// The sub-agent session events in order; the earliest scroll out of
			// the fold as output grows.
			of: (ctx) => ctx.result?.data?.events ?? [],
			rows: [
				{
					content: (_ctx, ev) => {
						const e = ev as { kind: string; name?: string; args?: string; text?: string };
						if (e.kind === "thinking") return { style: "thinking", content: "Thinking..." };
						if (e.kind === "tool") return { style: "tool", content: `${e.name ?? ""}: ${e.args ?? ""}` };
						return { style: "text", content: e.text ?? "" };
					},
				},
			],
		},
	},
	// Session footer: recoverable on the card, never into LLM context
	// (SPEC: footer 仅 session: <path>). Foreground completion and a started
	// background spawn both carry it.
	footer: (ctx) => ctx.result?.data?.sessionPath,
});

export const stopView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "agent_stop",
	title: (ctx) => titleFrom(ctx, "agentId"),
	tail: (ctx) => {
		if (ctx.status === "error") return "stop failed";
		if (ctx.status === "processing") return "stopping\u2026";
		return "stopped";
	},
});

export const sendView = createToolView<Record<string, unknown>, Record<string, unknown>>({
	name: "agent_send",
	title: (ctx) => titleFrom(ctx, "to"),
	tail: (ctx) => {
		if (ctx.status === "error") return "failed";
		if (ctx.status === "processing") return "sending\u2026";
		return "delivered";
	},
	// The message body shows on the card (head preview: first 10 rows, write-like).
	preview: "head",
	body: { text: (ctx) => (ctx.result?.data as { message?: string } | undefined)?.message ?? "" },
});
