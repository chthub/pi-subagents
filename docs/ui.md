# UI layer

The internal `ui/` modules support pi-subagents; they are not a separate package. Design and visual conventions are defined in [SPEC.md](../SPEC.md).

The primitives have two families: **views**, where a tool declares a data-to-card mapping and the library owns rendering, folding, colors, and status; and **non-view primitives**, including width safety (`width.ts`) and model-context protection (`context.ts`). Card callers supply data without calculating rendering widths themselves. The root `widget.ts` separately owns roster-row layout using pi's visible-width and truncation helpers.

## Responsibility boundaries

**The UI layer guarantees alignment and safe rendering; callers own content and presentation choices.**

- **Alignment**: the UI layer owns structural prefixes such as boxes and left padding, keeping content aligned at a fixed indent.
- **Safe rendering**: Pi rejects lines wider than the terminal, using `visibleWidth`. Collapsing newlines can produce misleading width estimates. The card primitives centralize flattening, clipping, and width budgets in `width.ts`; other rendering surfaces must also respect pi's visible-width semantics.
- **Single-line versus wrapping content**: callers use `structRow` for one width-safe physical line and `Text` for naturally wrapped complete content, consistent with bash.
- **Pure data**: pass titles, URLs, and queries unchanged. Truncate only at the rendering boundary, not with arbitrary slices in the data layer.

## Modules and import boundaries

| Module | Responsibility | Exports |
|---|---|---|
| `width.ts` | Width-safety helpers for the card primitives: `capPlain`, `structRow`, `clipTail`, `safeTitle`; measures through pi-tui's `visibleWidth` | All |
| `context.ts` | Model-context protection: `stashOverflow` for capped output and temporary storage, plus `truncationMarker` | All |
| `spinner.ts` | Spinner animation and `formatDuration`/`durationMeta`; width helpers are imported directly from `width.js` | All |
| `ticker.ts` | Shared animation clock, using the smallest subscribed interval | `ticker`, `TickerHandle` |
| `widget.ts` | Generic status primitives and shared types; `counterParts` supplies foreground subtree metadata. The product's conversation roster is rendered by root `widget.ts` | `StatusWidget`, `counterParts`, and related exports |
| `card.ts` / `view.ts` | Card building blocks and the declarative `createToolView` factory | See each module |
| `preview-runtime.ts` | Development-only storybook runtime with theme-loading support and a simulated host shell; production code must not import it | `createPreviewRuntime` |

There is no barrel index. Import each module directly to keep dependencies and responsibilities explicit.

## Folding

Folding never discards content: show the tail within the preview budget plus an expansion hint, then render the complete content when expanded. Only model-facing text is truncated, as described in the design principles; users can always expand the full output.
