/**
 * pi-subagents — the conversation's agent roster.
 *
 * Every sub-agent this conversation spawned, live or finished, in spawn
 * order: the bottom agent list renders it and the agent view opens entries
 * from it. Live updates come from the registry, the spawn tool and tree
 * telemetry; on session start the roster is rebuilt from the transcript
 * (spawn results + completion notifications), so it survives resume.
 *
 * Pure data — no pi API, no rendering.
 */

export type RosterStatus = "running" | "idle" | "done" | "failed" | "stopped";

export interface RosterActivity {
	style: "thinking" | "tool" | "text";
	content: string;
}

export interface RosterEntry {
	/** Bare agent id ("max"). */
	agentId: string;
	label: string;
	status: RosterStatus;
	startedAt: number;
	endedAt?: number;
	/** Child session file — what the agent view reads and a revive resumes. */
	sessionPath?: string;
	model?: string;
	/** Tool allowlist the agent was spawned with (not stored in its session). */
	tools?: string[];
	/** Working directory the child ran in. */
	cwd?: string;
	/** Latest activity excerpt while running. */
	activity?: RosterActivity;
	/** 0 = my direct child; deeper rows come from tree telemetry (no local process). */
	indent: number;
	parentId?: string;
}

export function isTerminal(status: RosterStatus): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

export class Roster {
	private readonly entries = new Map<string, RosterEntry>();
	private readonly listeners = new Set<() => void>();

	/** Add an entry or merge fields into an existing one. */
	upsert(fields: Partial<RosterEntry> & { agentId: string }): void {
		const prev = this.entries.get(fields.agentId);
		const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
		this.entries.set(fields.agentId, {
			label: fields.agentId,
			status: "running",
			startedAt: Date.now(),
			indent: 0,
			...prev,
			...defined,
		} as RosterEntry);
		this.changed();
	}

	/**
	 * Move an entry to a new status. Ending an agent also ends every live
	 * descendant row: nothing will report their end (the reporter was the
	 * process that died), and by construction they were taken down with it.
	 */
	setStatus(agentId: string, status: RosterStatus, at = Date.now()): void {
		const entry = this.entries.get(agentId);
		if (!entry) return;
		entry.status = status;
		if (isTerminal(status)) {
			entry.endedAt ??= at;
			entry.activity = undefined;
			for (const child of this.entries.values()) {
				if (child.parentId === agentId && !isTerminal(child.status)) this.setStatus(child.agentId, "stopped", at);
			}
		} else {
			entry.endedAt = undefined;
		}
		this.changed();
	}

	setActivity(agentId: string, activity: RosterActivity | undefined): void {
		const entry = this.entries.get(agentId);
		if (!entry || isTerminal(entry.status)) return;
		entry.activity = activity;
		this.changed();
	}

	get(agentId: string): RosterEntry | undefined {
		return this.entries.get(agentId);
	}

	/** Entries in spawn order. */
	list(): RosterEntry[] {
		return [...this.entries.values()];
	}

	/** Replace everything (session start: the rebuilt transcript roster). */
	reset(entries: RosterEntry[] = []): void {
		this.entries.clear();
		for (const e of entries) this.entries.set(e.agentId, e);
		this.changed();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		for (const listener of this.listeners) listener();
	}
}

// ── Rebuild from the transcript ─────────────────────────────────

/** The transcript message shapes this module reads (structural subset of pi's AgentMessage). */
interface TranscriptMessage {
	role: string;
	timestamp?: number;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	details?: unknown;
	customType?: string;
}

interface SpawnArgs {
	label?: string;
	tools?: string[];
}

interface SpawnResultDetails {
	agentId?: string;
	label?: string;
	runInBackground?: boolean;
	error?: string;
	sessionPath?: string;
	model?: string;
	startedAt?: number;
	endedAt?: number;
}

interface NotificationDetailsLite {
	status?: string;
	agent_id?: string;
	idle?: boolean;
	sessionPath?: string;
	usage?: { durationMs?: number | null };
}

/**
 * The roster a transcript describes, for a session whose agent processes are
 * gone (resume, reload, session switch): anything that was still running is
 * reported stopped, and a resident (idle) agent is done — both can be revived
 * from their session file.
 */
export function rosterFromMessages(messages: readonly TranscriptMessage[], cwd?: string): RosterEntry[] {
	const args = new Map<string, SpawnArgs>();
	const entries = new Map<string, RosterEntry>();

	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
				if (block.type === "toolCall" && block.name === "agent_spawn" && block.id)
					args.set(block.id, (block.arguments ?? {}) as SpawnArgs);
			}
			continue;
		}
		if (m.role === "toolResult" && m.toolName === "agent_spawn") {
			const d = (m.details ?? {}) as SpawnResultDetails;
			if (!d.agentId) continue; // never spawned (validation / model error)
			const a = args.get(m.toolCallId ?? "") ?? {};
			const failed = m.isError || d.error !== undefined;
			entries.set(d.agentId, {
				agentId: d.agentId,
				label: d.label ?? a.label ?? d.agentId,
				// A background spawn's outcome arrives later as a notification.
				status: failed ? "failed" : d.runInBackground ? "running" : "done",
				startedAt: d.startedAt ?? m.timestamp ?? 0,
				endedAt: d.runInBackground ? undefined : (d.endedAt ?? m.timestamp),
				sessionPath: d.sessionPath,
				model: d.model,
				tools: a.tools,
				cwd,
				indent: 0,
			});
			continue;
		}
		if (m.role === "custom" && m.customType === "subagent-notification") {
			const d = (m.details ?? {}) as NotificationDetailsLite;
			const entry = d.agent_id ? entries.get(d.agent_id.replace(/^@/, "")) : undefined;
			if (!entry) continue;
			entry.status = d.status === "failed" ? "failed" : d.status === "stopped" ? "stopped" : "done";
			entry.sessionPath = d.sessionPath ?? entry.sessionPath;
			entry.endedAt = d.usage?.durationMs ? entry.startedAt + d.usage.durationMs : m.timestamp;
			continue;
		}
		if (m.role === "toolResult" && m.toolName === "agent_stop") {
			const d = (m.details ?? {}) as { agentId?: string; error?: string };
			const entry = !m.isError && d.error === undefined && d.agentId ? entries.get(d.agentId) : undefined;
			if (entry && !isTerminal(entry.status)) {
				entry.status = "stopped";
				entry.endedAt = m.timestamp;
			}
		}
	}

	for (const entry of entries.values()) {
		if (entry.status === "running") entry.status = "stopped";
		else if (entry.status === "idle") entry.status = "done";
	}
	return [...entries.values()];
}
