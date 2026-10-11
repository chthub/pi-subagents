/** Branch-local roster persistence; never use the compacted model context as UI history. */
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { type Roster, type RosterEntry, rosterFromMessages } from "./roster.js";

export const ROSTER_STATE_TYPE = "pi-subagents-roster";

function snapshot(entries: readonly RosterEntry[]): RosterEntry[] {
	return entries.map((entry) => {
		const copy = { ...entry };
		delete copy.activity; // Do not copy an ever-growing streamed excerpt on every token.
		return structuredClone(copy);
	});
}

function readSnapshot(data: unknown): RosterEntry[] | undefined {
	if (!data || typeof data !== "object" || !("entries" in data) || !Array.isArray(data.entries)) return undefined;
	const entries: unknown[] = data.entries;
	if (
		!entries.every((entry) => {
			if (!entry || typeof entry !== "object") return false;
			const e = entry as Partial<RosterEntry>;
			return (
				typeof e.agentId === "string" &&
				e.agentId.length > 0 &&
				typeof e.label === "string" &&
				typeof e.startedAt === "number" &&
				Number.isFinite(e.startedAt) &&
				typeof e.indent === "number" &&
				Number.isInteger(e.indent) &&
				e.indent >= 0 &&
				["running", "idle", "done", "failed", "stopped"].includes(e.status ?? "")
			);
		})
	)
		return undefined;
	return snapshot(entries as RosterEntry[]);
}

/** Only the selected branch is supplied, so abandoned branches cannot leak into the list. */
export function rosterFromBranch(branch: readonly SessionEntry[], cwd?: string): RosterEntry[] {
	let initial: RosterEntry[] = [];
	let start = 0;
	for (const [index, entry] of branch.entries()) {
		if (entry.type !== "custom" || entry.customType !== ROSTER_STATE_TYPE) continue;
		const saved = readSnapshot(entry.data);
		if (saved) {
			initial = saved;
			start = index + 1;
		}
	}
	// Project individual raw entries, NOT buildSessionContext(branch), which
	// omits compacted/context-edited history and all custom state entries.
	const messages = branch.slice(start).flatMap((entry) => sessionEntryToContextMessages(entry));
	return rosterFromMessages(messages, cwd, initial);
}

/** Save only metadata changes; token/activity updates must not grow the session file. */
export function persistRoster(
	roster: Roster,
	append: (type: string, data: { entries: RosterEntry[] }) => void,
	onError?: (error: unknown) => void,
): () => void {
	let previous = JSON.stringify(snapshot(roster.list()));
	return roster.onChange(() => {
		const entries = snapshot(roster.list());
		const serialized = JSON.stringify(entries);
		if (serialized === previous) return;
		try {
			append(ROSTER_STATE_TYPE, { entries });
			previous = serialized;
		} catch (error) {
			// A failed session write must not escape the raw RPC event callback.
			onError?.(error);
		}
	});
}
