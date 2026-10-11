# pi-ui Specification

Shared primitives for Pi extensions have two families: **views**, where a tool declares a data-to-card mapping and the library owns rendering, folding, colors, and status; and **non-view primitives**, including width safety (`width.ts`) and model-context protection (`context.ts`). Tools do not calculate rendering widths themselves.

## Responsibility boundaries

**The UI layer guarantees alignment and safe rendering; callers own content and presentation choices.**

- **Alignment**: the UI layer owns structural prefixes such as boxes and left padding, keeping content aligned at a fixed indent.
- **Safe rendering**: Pi rejects lines wider than the terminal, using `visibleWidth`. Collapsing newlines can produce misleading width estimates. Flattening, clipping, and width budgets therefore have one implementation boundary, `width.ts`.
- **Single-line versus wrapping content**: callers use `structRow` for one width-safe physical line and `Text` for naturally wrapped complete content, consistent with bash.
- **Pure data**: pass titles, URLs, and queries unchanged. Truncate only at the rendering boundary, not with arbitrary slices in the data layer.

## Modules and import boundaries

| Module | Responsibility | Exports |
|---|---|---|
| `width.ts` | Sole width-safety boundary: `capPlain`, `structRow`, `clipTail`, `safeTitle`; measures through Pi TUI's `visibleWidth` | All |
| `context.ts` | Model-context protection: `stashOverflow` for capped output and temporary storage, plus `truncationMarker` | All |
| `spinner.ts` | Spinner animation and `formatDuration`/`durationMeta`; forwards `clipTail`/`safeTitle` for compatibility, while new imports use `width.js` | All |
| `ticker.ts` | Shared animation clock, using the smallest subscribed interval | `ticker`, `TickerHandle` |
| `widget.ts` | Status display, progress metadata, idle rows; `counterParts` owns shared counter vocabulary | `StatusWidget`, `counterParts`, and related exports |
| `card.ts` / `view.ts` | Card building blocks and the declarative `createToolView` factory | See each module |
| `preview-runtime.ts` | Development-only storybook runtime with theme-loading support and a simulated host shell; production code must not import it | `createPreviewRuntime` |

There is no barrel index. Import each module directly to keep dependencies and responsibilities explicit.

## Folding

Folding never discards content: show the tail within the preview budget plus an expansion hint, then render the complete content when expanded. Only model-facing text is truncated, as described in the shared design principles; users can always expand the full output.
