/**
 * pi-subagents — notification card renderer.
 *
 * Background-agent completion notifications (registerMessageRenderer) —
 * rendered directly: a custom message, not a tool result, so it does not
 * go through createToolView. Notification renderers own their styling;
 * every status uses Pi's custom-message background, not a tool shell.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, MouseRegion } from "@earendil-works/pi-tui";
import type { NotificationDetails, QuestionDetails } from "./types.js";
import {
	type BodyComponent,
	type CardBody,
	type CardConfig,
	type CardIcon,
	type Component,
	cardShell,
	contentRow,
	errorIcon,
	renderCard as renderCardUi,
	stoppedIcon,
	successIcon,
} from "./ui/card.js";
import { primaryClick } from "./ui/mouse.js";
import { formatDuration } from "./ui/spinner.js";

// Pi rebuilds custom renderers on invalidation, but does not give them an
// expansion callback. Keep local folding on the message identity, not the
// agent id (one agent can have several distinct replies in the transcript).
const messageFolds = new WeakMap<object, { hostExpanded: boolean; expanded: boolean }>();

/** Clickable custom-message card; Ctrl+O still controls all cards. */
function renderNotificationCard(message: object, config: CardConfig, theme: Theme): Component {
	let fold = messageFolds.get(message);
	if (!fold || fold.hostExpanded !== config.expanded) {
		fold = { hostExpanded: config.expanded, expanded: config.expanded };
		messageFolds.set(message, fold);
	}
	const state = fold;
	const content = new Container();
	let renderedExpanded = state.expanded;
	const rebuild = () => {
		renderedExpanded = state.expanded;
		content.clear();
		content.addChild(cardShell(theme, "customMessageBg", renderCardUi({ ...config, expanded: state.expanded }, theme)));
	};
	rebuild();
	const card: Component = {
		render(width) {
			// A captured press can outlive a host rebuild. All renderers for
			// this message must observe the shared fold when the click arrives.
			if (renderedExpanded !== state.expanded) rebuild();
			return content.render(width);
		},
		invalidate: () => content.invalidate(),
		handleMouse: (event) => content.handleMouse(event),
	};
	return new MouseRegion(card, (event) =>
		primaryClick(event, () => {
			state.expanded = !state.expanded;
			rebuild();
		}),
	);
}

/** Missing details: a dim one-liner inside the same custom-message shell. */
function renderNoDetailsCard(theme: Theme): BodyComponent {
	return cardShell(theme, "customMessageBg", contentRow(theme.fg("dim", "(no details)")));
}

function formatTokens(n: number): string {
	return n.toLocaleString("en-US");
}

/** Background-agent completion card: ✓/✗/■ + status word + usage meta. */
export function renderNotification(
	message: { details?: NotificationDetails },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Component {
	const d = message.details;

	if (!d) {
		return renderNoDetailsCard(theme);
	}

	const icon: CardIcon = d.status === "completed" ? successIcon : d.status === "failed" ? errorIcon : stoppedIcon;
	// The card name is the agent, never the tool that created it: a notification
	// is a message ("that agent finished"), and spelling it agent_spawn makes it
	// read as a fresh spawn next to the real spawn card. The status word is
	// what says the turn ended — carried by the icon + word, not the shell, so
	// every status shares the message background.
	const status: { text: string; color: "error" | "muted" | "warning" } =
		d.status === "failed"
			? { text: "failed", color: "error" }
			: d.status === "stopped"
				? { text: "stopped", color: "warning" }
				: { text: "completed", color: "muted" };

	const metaParts: string[] = [];
	if (d.model) metaParts.push(d.model);
	if (d.thinking) metaParts.push(d.thinking);
	if (d.usage?.durationMs != null) metaParts.push(`Took ${formatDuration(d.usage.durationMs)}`);
	if (d.usage?.tokens != null) metaParts.push(`${formatTokens(d.usage.tokens)} tokens`);
	if (d.usage?.toolUses != null) metaParts.push(`${d.usage.toolUses} tool use${d.usage.toolUses === 1 ? "" : "s"}`);
	// Persistent agent completed: resident (idle) — muted marker in the meta.
	if (d.idle) metaParts.push("idle");

	// Result text uses the internal UI layer's message body (folded block,
	// toolOutput color), separate from activity-stream rows.
	const body: CardBody = d.result?.trim() ? { message: d.result.trim() } : {};

	return renderNotificationCard(
		message,
		{
			header: { icon, name: "Agent", title: d.label, tail: status, meta: metaParts },
			body,
			footer: d.sessionPath,
			expanded,
		},
		theme,
	);
}

/** A child's question while it keeps working: `? Agent "@id — label" asks (non-blocking)`. */
export function renderQuestion(
	message: { details?: QuestionDetails },
	{ expanded }: { expanded: boolean },
	theme: Theme,
): Component {
	const d = message.details;
	if (!d) return renderNoDetailsCard(theme);
	return renderNotificationCard(
		message,
		{
			header: {
				icon: { glyph: "?", color: "accent" },
				name: "Agent",
				title: d.label,
				tail: { text: "asks (non-blocking)", color: "muted" },
			},
			body: d.question.trim() ? { message: d.question.trim() } : {},
			expanded,
		},
		theme,
	);
}
