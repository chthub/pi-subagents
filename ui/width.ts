/**
 * Internal UI layer — width safety for structural rows.
 *
 * pi crashes on any rendered line wider than the terminal (visibleWidth is
 * its crash metric), and newlines collapse to zero width — so flattening,
 * capping and alignment live here, single-pointed. Callers decide what the
 * content is and whether it may wrap (multi-line content belongs in Text
 * components, which wrap); a structRow is one physical line that always fits.
 */

import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Collapse whitespace and cut long tails to `max` columns (ellipsis prefix). */
export function clipTail(s: string, max = 60): string {
	if (max <= 0) return "";
	const clean = s.replace(/\s+/g, " ").trim();
	const width = visibleWidth(clean);
	if (width <= max) return clean;
	return `\u2026${sliceByColumn(clean, width - (max - 1), max - 1, true)}`;
}

/** Cut plain text to `max` columns keeping the head, trailing ellipsis. */
export function capPlain(s: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(s) <= max) return s;
	return `${sliceByColumn(s, 0, max - 1, true)}\u2026`;
}

/**
 * Task title, rendered safe for a single quoted line: tabs/newlines are
 * flattened and embedded double quotes neutralized (so quotes around the
 * title can't be broken). Pass `max` to also cap the width with a trailing
 * ellipsis (single-line contexts without a wrap fallback); omit it where the
 * renderer wraps long lines (card headers — bash-style full display).
 */
export function safeTitle(title: string | undefined, max?: number): string {
	const flat = (title ?? "(untitled)")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/"/g, "'")
		.trim();
	if (max === undefined) return flat;
	return capPlain(flat, max);
}

/**
 * One structural row that always fits `width`:
 *
 *   [prefix] content [suffix]
 *
 * - `prefix` fixes the alignment (styled OK; visibleWidth skips ANSI), clipped
 *   without an ellipsis if the structural text alone exceeds the budget.
 * - `content` is plain text — flattened and capped to exactly what's left,
 *   zero safety margin (same metric as pi's crash check).
 * - `suffix` is right-side text (live meta), styled OK. It takes priority over
 *   the prefix/content, but is itself capped when wider than the whole row.
 *
 * Which end of over-long content to sacrifice is the caller's call:
 * "head" (default) keeps the beginning (titles); "tail" keeps the latest
 * (activity streams, pi-bash style).
 */
export function structRow(opts: {
	prefix: string;
	content: string;
	suffix?: string;
	width: number;
	keep?: "head" | "tail";
	styleContent?: (capped: string) => string;
}): string {
	if (opts.width <= 0) return "";
	const flat = opts.content.replace(/[\r\n\t]+/g, " ").trim();
	const suffix = capPlain(opts.suffix ?? "", opts.width);
	const prefix = truncateToWidth(opts.prefix, opts.width - visibleWidth(suffix), "");
	const avail = Math.max(0, opts.width - visibleWidth(prefix) - visibleWidth(suffix));
	const capped = opts.keep === "tail" ? clipTail(flat, avail) : capPlain(flat, avail);
	return truncateToWidth(`${prefix}${opts.styleContent ? opts.styleContent(capped) : capped}${suffix}`, opts.width, "");
}
