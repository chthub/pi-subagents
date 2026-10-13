/**
 * pi-subagents — subtree display: where a child's telemetry lands.
 *
 * The single-display rule (SPEC) as one module. Given the anchor facts (am I the
 * root? is this child foreground? is my card still open?), every tree
 * event resolves to exactly one surface:
 *   - fold   → this card's nested counters (one subtree, one surface)
 *   - forward → scoped to its child edge, then to my parent (depth + 1)
 *   - widget → rows on the root widget
 *
 * The interface is the test surface: drive events through onTreeEvent with
 * fake seams and assert folding, forwarding, and widget application.
 */

import type { AgentTreeEvent } from "./event-interpret.js";
import { createNestedFold, type NestedCounters, resolveTreeAnchor } from "./nested-fold.js";
import type { AgentWidget } from "./widget.js";

/** A display key may contain parent edges; user-facing names remain local. */
export function displayAgentId(key: string): string {
	return key.slice(key.lastIndexOf("/") + 1);
}

/** Scope every event at its source connection, before folding or forwarding. */
function scopeEvent(childId: string, event: AgentTreeEvent): AgentTreeEvent {
	const id = `${childId}/${event.id}`;
	if (event.op !== "add") return { ...event, id };
	return {
		...event,
		id,
		parent: event.depth === 1 ? childId : event.parent ? `${childId}/${event.parent}` : undefined,
	};
}

/** Apply a forwarded tree event to the root widget (pure data rows). */
function applyTreeEvent(widget: AgentWidget, event: AgentTreeEvent): void {
	switch (event.op) {
		case "add":
			widget.addNested({
				agentId: event.id,
				label: event.label,
				startedAt: event.startedAt,
				indent: event.depth,
				status: event.status,
				parentId: event.parent,
			});
			break;
		case "activity":
			widget.updateActivity(event.id, event.activity);
			break;
		case "remove":
			widget.remove(event.id, event.status);
			break;
	}
}

interface SubtreeDisplay {
	/** Anchor + deliver one telemetry event to its single surface. */
	onTreeEvent(event: AgentTreeEvent): void;
	/** Freeze the card (execute returned): from here folding would vanish —
	 *  persistent children surface on the widget instead. */
	closeCard(): void;
	/** Current descendant counters for the card meta. */
	nested(): NestedCounters;
}

export function createSubtreeDisplay(opts: {
	/** Local name of the child whose RPC connection supplies these events. */
	childId: string;
	hasParent: boolean;
	/** Constant per spawn: is MY child a foreground edge (card owns it)? */
	foregroundEdge: boolean;
	/** Widget access — may lazily create it; undefined only in non-TUI. */
	getWidget(): AgentWidget | undefined;
	/** Parent seam: report edge-scoped telemetry upward (non-root only). */
	forward(event: AgentTreeEvent): void;
	/** Card seam: a fold changed the counters — refresh the live card. */
	onFold(): void;
}): SubtreeDisplay {
	const nested = createNestedFold();
	let cardClosed = false;
	return {
		onTreeEvent(raw: AgentTreeEvent): void {
			const event = scopeEvent(opts.childId, raw);
			switch (
				resolveTreeAnchor({
					hasParent: opts.hasParent,
					foregroundEdge: opts.foregroundEdge,
					cardClosed,
				})
			) {
				case "fold":
					nested.fold(event);
					opts.onFold();
					return;
				case "forward":
					opts.forward(event.op === "add" ? { ...event, depth: event.depth + 1 } : event);
					return;
				case "widget": {
					const widget = opts.getWidget();
					if (widget) applyTreeEvent(widget, event);
				}
			}
		},
		closeCard(): void {
			cardClosed = true;
		},
		nested() {
			return nested.snapshot();
		},
	};
}
