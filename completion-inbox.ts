/**
 * Session-scoped completion delivery. Busy parents consume all ready results at
 * the next actionable boundary, not one follow-up per model response. Idle
 * parents get separate native cards but only one wake for the ready batch.
 * No polling, semantic filtering, per-agent overwrites, or global queue changes.
 */
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

export type CompletionNotice = CustomMessageEntryDraft & { details: { completionId: string } };
type Boundary = TurnEndEvent | AgentBeforeSettleEvent;

export function registerCompletionInbox(pi: ExtensionAPI): {
	/** Bind before starting a child; callbacks from an old session cannot leak. */
	capture: () => (notice: CompletionNotice) => void;
} {
	let pending: CompletionNotice[] = [];
	const seen = new Set<string>();
	let generation = 0;
	let closed = true;
	let running = false;
	let suspended = false;
	let context: ExtensionContext | undefined;
	let scheduled: ReturnType<typeof setImmediate> | undefined;

	const cancelScheduled = (): void => {
		if (scheduled) clearImmediate(scheduled);
		scheduled = undefined;
	};
	const take = (): CompletionNotice[] => {
		const batch = pending;
		pending = [];
		return batch;
	};
	const scheduleIdle = (): void => {
		if (closed || scheduled || running || !pending.length) return;
		// One event-loop tick to collect ready callbacks, not a wait for slow agents.
		scheduled = setImmediate(() => {
			scheduled = undefined;
			if (closed || running || !context?.isIdle()) return;
			const batch = take();
			const wake = !suspended && !context.signal?.aborted;
			if (batch.length && wake) running = true;
			// Append N-1 cards without a turn, then the last card starts ONE run.
			// sendMessage's idle append is synchronous; no await between these calls.
			for (const [index, notice] of batch.entries()) {
				pi.sendMessage(notice, { deliverAs: "steer", triggerTurn: wake && index === batch.length - 1 });
			}
		});
	};
	const startSession = (_event: unknown, ctx: ExtensionContext): void => {
		cancelScheduled();
		generation++;
		pending = [];
		seen.clear();
		context = ctx;
		closed = false;
		running = !ctx.isIdle();
		suspended = false;
	};
	const boundary = (event: Boundary, ctx: ExtensionContext): BoundaryResult | undefined => {
		context = ctx;
		if (closed) return;
		const interrupted = event.outcome !== "completed" || ctx.signal?.aborted === true;
		suspended = interrupted;
		if (!pending.length) return;
		cancelScheduled();
		// Even on abort/error, preserve results as ordinary context/cards, but do
		// NOT request continuation. Later idle completions are also appended silently.
		// canContinue before adding our entries may be false (last role assistant);
		// Pi recomputes it against these custom messages after the handler returns.
		return {
			entries: [...event.entries, ...take()],
			...(interrupted ? {} : { continue: true }),
		};
	};

	pi.on("session_start", startSession);
	pi.on("session_tree", (_event, ctx) => {
		// Same conversation, fresh branch context; live children still belong here.
		context = ctx;
		scheduleIdle();
	});
	pi.on("agent_start", (_event, ctx) => {
		context = ctx;
		running = true;
		suspended = false;
		cancelScheduled();
	});
	pi.on("turn_end", boundary);
	pi.on("agent_before_settle", boundary);
	pi.on("agent_settled", (event, ctx) => {
		context = ctx;
		running = false;
		if (event.aborted) suspended = true;
		scheduleIdle();
	});
	pi.on("session_compact", (_event, ctx) => {
		context = ctx;
		scheduleIdle();
	});
	pi.on("session_shutdown", () => {
		cancelScheduled();
		closed = true;
		generation++;
		// Keep already collected output in the old session on orderly shutdown.
		// The canonical result also survives in each child's own session file.
		for (const notice of take()) pi.sendMessage(notice, { triggerTurn: false });
		context = undefined;
	});

	return {
		capture: () => {
			const owner = generation;
			return (notice) => {
				if (closed || owner !== generation || seen.has(notice.details.completionId)) return;
				seen.add(notice.details.completionId);
				pending.push(notice);
				scheduleIdle();
			};
		},
	};
}
