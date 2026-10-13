/**
 * pi-subagents — AgentRegistry.
 *
 * Owns child lifecycle, completion policy, and routing. Keeps registry
 * membership, widget rows, and child processes in sync.
 *
 * The registry depends on narrow seams — a notify callback and a widget
 * surface — so the completion policy is unit-testable without a pi API or a
 * TUI. AgentProcess satisfies RegisteredAgent structurally; index.ts adapts
 * the TUI widget via WidgetSurface.
 *
 * Policy:
 *   - agent_stop is deliberate control → no new completion notification.
 *   - Timeout/hard-stop completions still notify with status "stopped".
 *   - Completed persistent agents remain registered and idle.
 *   - Other completions notify before cleanup; removal is idempotent.
 */

import type { AgentCompletion } from "./agent-process.js";
import { randomAgentName } from "./name-gen.js";
import { type AgentMessage, type RouteDecision, routeMessage } from "./protocol.js";
import type { WidgetResult } from "./ui/widget.js";

/** Narrow agent surface the registry needs — AgentProcess satisfies it. */
export interface RegisteredAgent {
	readonly agentId: string;
	readonly label: string;
	readonly model?: string;
	readonly thinking?: string;
	/** Resident after completion (idle) — explicit opt-in; complete() keeps it. */
	readonly persistent?: boolean;
	/** Deliver one in-tree message to this agent (AgentProcess.sendMessage). */
	sendMessage?: (text: string) => Promise<boolean>;
	stoppedByControl: boolean;
	readonly status?: "queued" | "running" | "completed" | "failed" | "stopped";
	/** A newer accepted turn must not be cleaned up by an old settlement. */
	isCurrentCompletion?: (completion: AgentCompletion) => boolean;
	stop(): Promise<void>;
}

/** Narrow widget surface — index.ts adapts the TUI AgentWidget to it. */
export interface WidgetSurface {
	/** `status` = the row's lifecycle state at registration (background settle = running;
	 *  foreground resident = idle — never a terminal status: the widget's terminal
	 *  cleanup removes such rows immediately). */
	add(agent: RegisteredAgent, status?: "running" | "idle"): void;
	/** `result` feeds the widget's lifetime progress meta; undefined = unknown. */
	remove(agentId: string, result?: WidgetResult): void;
	/** In-place status update (idle ⇄ running for persistent agents). */
	setStatus?(agentId: string, status: "idle" | "running"): void;
	dispose(): void;
}

interface AgentRegistryDeps {
	/** Deliver a completion notification (index.ts wraps pi.sendMessage). */
	notify: (agent: RegisteredAgent, completion: AgentCompletion) => Promise<void> | void;
	/** Lazy widget access — null in non-TUI modes. */
	getWidget?: () => WidgetSurface | null;
	/** This process is itself a child agent ("@parent" is deliverable upward). */
	hasParent?: boolean;
}

export class AgentRegistry {
	private readonly agents = new Map<string, RegisteredAgent>();
	private readonly notify: AgentRegistryDeps["notify"];
	private readonly getWidget: NonNullable<AgentRegistryDeps["getWidget"]>;
	private readonly hasParent: boolean;
	/** Names handed out this session — re-roll on collision (pool ~200). */
	private readonly usedNames = new Set<string>();

	constructor(deps: AgentRegistryDeps) {
		this.notify = deps.notify;
		this.getWidget = deps.getWidget ?? (() => null);
		this.hasParent = deps.hasParent ?? false;
	}

	/**
	 * Short human-name id (max, zoe, kai…) — the LLM-facing agent reference
	 * for this session (agent_send targets, notification JSON). Names read
	 * as names (not machine codes) and cost ~1 token each; uniqueness is
	 * this session's live set (re-roll on collision).
	 */
	nextAgentId(): string {
		const name = randomAgentName(this.usedNames);
		this.usedNames.add(name);
		return name;
	}

	/** Keep ids already used in this conversation (restored from the transcript) out of the pool. */
	reserveIds(ids: Iterable<string>): void {
		for (const id of ids) this.usedNames.add(id);
	}

	/** Track a background agent: registry entry + widget row. */
	register(agent: RegisteredAgent, status: "running" | "idle" = "running"): void {
		this.agents.set(agent.agentId, agent);
		this.getWidget()?.add(agent, status);
	}

	lookup(agentId: string): RegisteredAgent | undefined {
		return this.agents.get(agentId);
	}

	/** Ids of the tracked agents, in registration order. */
	ids(): string[] {
		return [...this.agents.keys()];
	}

	/** Release an exited instance without stopping it or discarding its pending result. */
	removeExited(agent: RegisteredAgent, result?: WidgetResult): void {
		this.remove(agent.agentId, result, agent);
	}

	/**
	 * Completion policy + cleanup, single choke point. Notifies unless the
	 * stop was user-controlled; always removes the bookkeeping and stops the
	 * child (idempotent — safe for never-registered spawn failures and for
	 * completions arriving after stopAndRemove). A persistent agent that
	 * completed stays registered (idle, process resident) — agent_stop
	 * removes it later.
	 */
	async complete(agent: RegisteredAgent, completion: AgentCompletion): Promise<void> {
		const notify = () =>
			(completion.stoppedByControl ?? agent.stoppedByControl) ? Promise.resolve() : this.notify(agent, completion);
		if (agent.persistent && completion.status === "completed") {
			try {
				// A failed notification must never kill a resident agent — the
				// idle row stays (addressable), the agent stays up.
				await Promise.resolve(notify()).catch(() => {});
			} finally {
				// Resident — no remove, no stop. The widget row flips to idle so
				// the agent stays addressable (agent_stop removes it later).
				if (
					this.agents.get(agent.agentId) === agent &&
					this.isCurrent(agent, completion) &&
					(!agent.status || agent.status === "completed")
				) {
					this.getWidget()?.setStatus?.(agent.agentId, "idle");
				}
			}
			return;
		}
		try {
			await notify();
		} finally {
			if (this.isCurrent(agent, completion)) {
				this.remove(agent.agentId, completion.status === "completed" ? "done" : completion.status, agent);
				await agent.stop().catch(() => {});
			}
		}
	}

	/**
	 * Route one message against my direct children (pure; the caller — the
	 * agent_send execute or the inbound handler — acts on the decision:
	 * deliver to a child / inject the parent LLM / error).
	 */
	route(msg: AgentMessage): RouteDecision {
		return routeMessage(msg, this.ids(), this.hasParent);
	}

	/** Point-to-point delivery to a direct child by exact id. */
	async deliver(target: string, text: string): Promise<boolean> {
		const agent = this.agents.get(target);
		if (!agent?.sendMessage) return false;
		const ok = await agent.sendMessage(text);
		// A delivered message woke an idle persistent agent — the widget row
		// flips back to running (spinner resumes). Harmless for running rows.
		if (ok && this.agents.get(target) === agent && (!agent.status || agent.status === "running")) {
			this.getWidget()?.setStatus?.(target, "running");
		}
		return ok;
	}

	/** Flip a persistent agent's widget row back to idle (wake finished). */
	markIdle(agentId: string, completion?: AgentCompletion): void {
		const agent = this.agents.get(agentId);
		if (!agent || (completion && !this.isCurrent(agent, completion)) || (agent.status && agent.status !== "completed"))
			return;
		this.getWidget()?.setStatus?.(agentId, "idle");
	}

	/** agent_stop path: graceful stop + removal (no notification).
	 *  Returns whether an agent was actually stopped (false when it finished
	 *  between lookup and removal). A rejecting stop() propagates — the
	 *  caller (agent_stop.execute) surfaces it as a tool error.
	 *  `result` is the row's end state: a failed
	 *  follow-up turn is cleaned up here too and must not read "stopped". */
	async stopAndRemove(
		agentId: string,
		result: WidgetResult = "stopped",
		completion?: AgentCompletion,
	): Promise<boolean> {
		const agent = this.agents.get(agentId);
		if (!agent || (completion && !this.isCurrent(agent, completion))) return false;
		await agent.stop();
		this.remove(agentId, result, agent);
		return true;
	}

	/** Stop everything (session shutdown). */
	async shutdown(): Promise<void> {
		const agents = [...this.agents.values()];
		this.agents.clear();
		this.getWidget()?.dispose();
		await Promise.all(agents.map((agent) => agent.stop().catch(() => {})));
	}

	private isCurrent(agent: RegisteredAgent, completion: AgentCompletion): boolean {
		return agent.isCurrentCompletion?.(completion) ?? true;
	}

	private remove(agentId: string, result?: WidgetResult, expected?: RegisteredAgent): void {
		if (expected && this.agents.get(agentId) !== expected) return;
		// Only touch the widget for agents we actually tracked — a spawn-
		// failure completion never registered, so delete() returns false and
		// the widget stays untouched (no spurious requestRender).
		if (this.agents.delete(agentId)) this.getWidget()?.remove(agentId, result);
	}
}
