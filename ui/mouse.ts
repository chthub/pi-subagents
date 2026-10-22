import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/** Claim the press so Pi 1.4 routes the click directly, without text-selection fallback. */
export function primaryClick(
	event: Pick<TuiMouseEvent, "type" | "button">,
	onClick: () => void,
): TuiMouseEventResult | undefined {
	if (event.button !== "left") return undefined;
	if (event.type === "press") return { handled: true, render: false };
	if (event.type !== "click") return undefined;
	onClick();
	return { handled: true, render: true };
}
