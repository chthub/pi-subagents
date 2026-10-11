# pi-extensions Design Principles

> These principles apply to extensions under `packages/*`. Each package records its specific design in its own `SPEC.md`; shared principles have this single source.

## Pi Native

- **Consistent calls**: tool schemas and naming follow Pi built-ins such as `bash`, `read`, and `edit`. `promptSnippet` and `promptGuidelines` integrate with the system prompt.
- **Consistent output**: use Pi-native rendering components, typography, colors, folding, and status inference. Widget and working indicators use the same accent/dim visual language.
- **Consistent visual family**: cards, notifications, and widgets share status and formatting conventions, without promotional branding or decorative emoji.
- **Native capabilities**: reuse Pi session storage and `--session <path>` inspection rather than building an alternate session system.

## LLM + Token Friendly

- **Token economy**: model-facing `content` contains only necessary structured data. Display-only titles, usage, and metadata live in `details`, which does not enter model context.
- **Pure boundaries**: protocol serialization, parsing, and model resolution are independently testable pure functions.
- **No polling**: push each background completion once; do not add result polling/query primitives.

## Primitives rather than solutions

Provide capabilities for callers to compose. Coordination belongs in caller instructions, not tool implementations. Do not hard-code workflow templates, automatic retries, result postprocessing, or predefined agent types.

## Minimalism

Do not add a mechanism solely because a user or model might misuse a capability:

- No hidden token ceiling or default timeout. Limits are explicit caller options, such as `timeoutMs`.
- No redundant notifications. Report each event once: for example, a spawn failure already returned as an error tool result does not need another completion notification.

## Shared visual conventions

Cards, notifications, and widgets follow Pi's built-in visual language:

- **Leading icon**: place status icons first, consistent with the native Loader.
- **Box throughout**: all tool phases retain their card wrapper, including pending, success, and failure.
- **Metadata separator**: use `·` between metadata items, not within verb phrases. Time belongs in header metadata; the footer contains path summaries.
- **Body alignment**: align content to the card's left edge rather than header text. Blank lines separate sections.
- **Folding**: show a tail preview and expansion hint when collapsed; render everything when expanded.
- **Model-context limits**: cap model-facing content using the same limits as bash output. Never truncate the UI's complete rendering source.
- **Rendering-only fallback**: missing content gets a dim parenthesized placeholder, consistent with `(no output)`.

## Immediate TUI feedback

- Show meaningful activity when execution changes state, rather than waiting for the final result.
- Long silence without a working indicator or activity is a defect.
- Previews must match actual behavior, without inventing or omitting UI feedback.
- Use `working…` for generic active status; use a more specific operation when available.

## Development constraints

- Do not add third-party UI libraries.
- Use `StringEnum` for parameter enums, for Gemini compatibility.
- For blank lines, use `Text("\n" + content)`, not `Text("")`.
- Never call `context.invalidate()` synchronously from a render function.
