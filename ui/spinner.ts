/**
 * Internal UI layer — shared animation and duration formatting.
 *
 * Spinner (wall-clock driven frames) and duration formatting — used by
 * tool cards, widgets and notification surfaces. Text clipping and title
 * sanitization live in width.ts and are imported directly from there.
 */

/** Spinner frame interval (80ms — matches Pi's native loader cadence).
 * Single source for animation cadence: the ticker and every animated
 * component subscribe with this — no magic numbers elsewhere. */
export const SPINNER_TICK_MS = 80;

/** Spinner frames (one Braille frame per tick). */
const SPINNER = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

/**
 * Spinner animation driven by wall-clock time: `current()` derives the frame
 * from time elapsed since construction, so the cadence stays a steady 80ms no
 * matter how often the UI re-renders.
 */
export class Spinner {
	private readonly startedAt = Date.now();
	current(): string {
		return SPINNER[Math.floor((Date.now() - this.startedAt) / SPINNER_TICK_MS) % SPINNER.length];
	}
}

/** Seconds with one decimal — shared by cards, widgets and headers. */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Compact English elapsed time for the bottom agent list (seconds, then minutes). */
export function formatElapsed(ms: number): string {
	const tenths = Math.max(0, Math.round(ms / 100));
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const seconds = Math.floor(tenths / 10);
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

/**
 * Duration meta shared by tool views: a live `Elapsed` while running (wall
 * clock, updates every frame), a fixed `Took` once complete. Pass the task's
 * startedAt (the call seeds it into the render state at execution start).
 */
export function durationMeta(
	status: "processing" | "success" | "error" | "stop",
	startedAt?: number,
	endedAt?: number,
): string | undefined {
	if (startedAt == null) return undefined;
	if (status === "processing") return `Elapsed ${formatDuration(Date.now() - startedAt)}`;
	return `Took ${formatDuration((endedAt ?? Date.now()) - startedAt)}`;
}
