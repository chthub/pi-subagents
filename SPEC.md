# pi-subagents Specification

A minimal, complete sub-agent framework for pi. This file is the design contract; [docs/ui.md](docs/ui.md) records the internal UI module boundaries.

## Design principles

### Minimal interface, complete lifecycle

Three operations — spawn, send, stop — cover delegation, communication, follow-ups, and cancellation. The framework owns process lifecycle, automatic result delivery, session persistence and recovery, and native inspection. Minimalism reduces the concepts callers must learn; it does not omit the machinery needed to finish and revisit work.

Provide mechanisms for callers to compose, not a workflow engine. Do not hard-code roles, workflow templates, automatic retries, result postprocessing, or scheduling. Coordination guidance belongs in the on-demand skill, not tool implementations.

### Pi-native integration

- Reuse pi's RPC, session storage, model configuration, and native rendering components rather than introducing another harness or session format.
- Follow built-in tool naming and schema conventions. Keep operational descriptions separate from coordination instructions.
- Cards, notifications, and widgets use pi's typography, colors, folding, and status conventions, without promotional branding or decorative emoji.
- Keep execution independent of rendering so non-interactive modes remain functional.

### Context economy and explicit policy

- Model-facing `content` contains only necessary data; display-only titles, usage, and metadata live in `details`.
- Agent tools activate on demand. Advertise the coordination skill without loading its full body into every context.
- Push background results automatically; do not add polling or result-query tools. Report each event once: a spawn failure returned as a tool error needs no extra completion notification.
- No hidden token ceiling, default timeout, or concurrency cap. Limits such as `timeoutMs` and nesting depth are explicit caller choices.
- Keep protocol serialization, parsing, and model resolution independently testable pure boundaries.

### Visual and implementation conventions

- Place status icons first and retain the card wrapper through pending, success, and failure.
- Separate metadata with `·`; time belongs in header metadata, paths in the footer. Align body content to the card's left edge, with blank lines between sections.
- Collapsed output uses a preview and expansion hint; expanded output retains the complete rendering source. Cap model-facing text at bash's output limits, not the UI source.
- Missing output uses a dim parenthesized placeholder. Show meaningful activity as execution changes state; long silence without feedback is a defect. Use `working…` only when no more specific operation is available.
- Development previews must reflect actual behavior. Do not add third-party UI libraries.
- Use `StringEnum` for parameter enums for Gemini compatibility. For blank lines, use `Text("\n" + content)`, not `Text("")`. Never call `context.invalidate()` synchronously from a render function.

## Problem statement

Pi has no built-in sub-agents. Delegation is useful when verbose intermediate output (search results, logs, and tests) would crowd the main context, or when independent tasks should run concurrently without blocking the main conversation:

- **Context isolation**: intermediate child work stays out of the main context.
- **Parallel execution**: independent tasks can run concurrently without blocking the main agent.
- **Control**: messages redirect running work (`agent_send`), and `agent_stop` stops it.
- **Observability**: the TUI shows activity, and saved sessions support later review.

> Pi provides parallel tool execution: multiple tool calls in one response run concurrently. This extension does not add a worker queue.

## Solution

A Pi extension registers three verb-suffixed primitives, consistent with built-in names such as `read`, `write`, `edit`, and `web_search`. There is no action enum or predefined agent type system:

- **`agent_spawn`**: create an isolated agent, either foreground or background, with optional persistent residency.
- **`agent_stop`**: stop a running or resident child process.
- **`agent_send`**: message a direct child; every child may also address `@parent`, its direct parent. At the default depth, a child's only agent tool is this one, restricted to `@parent` and used only for non-blocking questions; final replies return automatically and carry blocking questions and the final report, and the parent handles coordination.

Each child is a resident `pi --mode rpc` process with an independent context and a persisted session.

## User stories

1. Delegate research without filling the main context with intermediate output; return a usable text result.
2. Run independent background tasks concurrently, show their status, and deliver ready results in batches.
3. Redirect work with `agent_send` or stop incorrect execution with `agent_stop`.
4. Override the model, thinking level, and tool allowlist per child.
5. Find a child's session path in its tool or notification card and review it with `pi --session <path>`.
6. Keep nesting disabled by default (`maxDepth=1`); raise the shared tree depth limit when needed.
7. On host exit, close child stdin for orderly shutdown without orphan processes; remove descendant display rows together. Never delete saved sessions.
8. When missing information prevents progress, the child asks a question and ends its reply. The parent receives it automatically and answers with `agent_send`, preserving context.
9. Keep persistent children idle after completion, with no model tokens consumed; resume them with `agent_send` instead of spawning again.
10. When the child has a non-blocking question (one it can keep working around), it sends it to `@parent` with `agent_send` and keeps working; the parent's reply appears in the child's conversation once its current tool calls finish or its turn ends (a finished turn is resumed by the reply). `agent_send` is not used for blocking questions, progress updates, or results.

## UI design

### agent_spawn tool card

```text
✓ agent_spawn "Check CI configuration" (sonnet · high · Took 27.5s · done 2/3 · 1 running)
⠙ agent_spawn "Check CI configuration" (claude-sonnet · high · Elapsed 12.3s)
Thinking...
bash: pnpm check
<blank line>
... (12 earlier lines, ctrl+o to expand)
<last five lines of child output>
<blank line>
session: /path/to/session.jsonl
```

- Header: status icon, `agent_spawn`, quoted label, and muted metadata. Time comes from shared state. Background `renderCall` is empty because background spawn uses a separate result card. Foreground metadata includes nested-subtree counters (`done n/total · n running · …`) using the widget vocabulary; see the single-display rule below.
- Body: a mixed activity stream starting with the prompt, then thinking, tool calls, and streamed text. Older content leaves the collapsed preview as output grows.
- Footer: only `session: <path>`.
- Thinking: the `thinking` parameter accepts `"off"` through `"max"`; omission inherits the dispatching session's level.

**Background spawn result card**, updated in place:

```text
⠋ agent_spawn "Check CI configuration" starting…
✓ agent_spawn "Check CI configuration" started
✗ agent_spawn "Check CI configuration" start failed
  Model not found
```

- Status is visible through the leading icon. Failures use the shared collapsed-preview and full-expansion rules, consistent with bash.
- The background agent ID appears in model-facing tool content, not on the spawn card.

### agent_stop / agent_send result cards

```text
✓ agent_stop "@zoe — research db schema" stopped

✓ agent_send "@zoe — research db schema" delivered
  Focus on indexes and slow queries in the orders table

✓ agent_send "@parent" delivered
  Should the report also cover the archived tables?

✗ agent_stop "@max" stop failed
  agent not found
```

- `agent_send.to` is a short child ID returned by spawn/notification, or `@parent` in a child. A child at the depth limit accepts only `@parent`.
- Message text appears in full, including multiple lines; messages over ten lines use a head preview when collapsed, consistent with write.
- Animation updates the same line, never appends new lines.
- Errors retain the same shape: an error-colored status line and a dim explanation.

### Non-blocking question card

A child's `agent_send` to `@parent`, as the parent sees it:

```text
? Agent "@zoe — research db schema" asks (non-blocking)
<blank line>
Should the report also cover the archived tables?
```

- Same `customMessageBg` shell as the completion card; the `?` icon and `asks (non-blocking)` set it apart from a final reply.
- Model content is `{kind: "non_blocking_question", agent_id, question}`; the card title and label stay in `details`.

### Completion notification card

Persistent completion includes an idle marker:

```text
✓ Agent "@max — Check CI configuration" completed (sonnet · high · Took 27.5s · 1,250 tokens · 3 tool uses · idle)
<blank line>
... (3 earlier lines, ctrl+o to expand)
Found five files handling authentication: src/auth/*.ts …
<blank line>
session: /path/to/session.jsonl
```

- The card name is `Agent`, not `agent_spawn`: this message reports the child's completion rather than a tool call. Status uses an icon and word: completed is muted, failed uses the error color, and stopped uses the warning color. Persistent completion adds `idle` to metadata.
- Background color is `customMessageBg`, Pi's injected-message color. Tool backgrounds remain reserved for actual tool cards. A custom renderer owns its styling rather than receiving Pi's default wrapper.
- Rendering data lives in `details`, outside the model context.

### Conversation agent list (belowEditor)

```text
  ⠋ @max  Check CI configuration   42s  bash: npm test
  ‖ @zoe  Resident research agent  idle
  ✓ @kai  Inspect auth module     27s
  Click to open · /agents
```

- The roster retains running, idle, done, failed, and stopped agents for this conversation. A finished process does not remove its saved-session entry.
- Each row shows the agent's ID, task label, elapsed time or status, and latest activity while active. Persistent completion changes the row to idle (`‖`); terminal entries remain available for review and revival.
- When rows exceed the display budget, prioritize live agents, then the most recently finished, preserving spawn order. The hint shows the number of hidden entries and `/agents`.
- Clicking a row or invoking `/agents` opens the native agent view. An empty roster hides the list. Resume and reload reconstruct it from the current session branch.
- Layout uses the terminal width supplied to rendering and pi's visible-width helpers.

## Implementation decisions

### Architecture

```text
index.ts            — tool registration and routing glue
protocol.ts         — pure JSONL protocol and routing
rpc-client.ts       — subprocess transport, framing, commands, and events
agent-process.ts    — semantic interface to one resident RPC process
event-interpret.ts  — pure RPC-event interpretation
notification.ts     — capped model payload and complete card details
completion-inbox.ts — session-scoped batching and idle wake control
tree-display.ts     — subtree routing to cards, widgets, or ancestors
registry.ts         — child lifecycle, completion policy, and delivery
model.ts            — model resolution
types.ts            — shared event and result types
render.ts           — notification payload rendering and card shell
widget.ts           — conversation agent list
name-gen.ts         — short agent IDs
spawn-session.ts    — foreground/background/persistent lifecycle
nested-fold.ts      — foreground subtree counters
views.ts            — the three tool-card views
preview.ts          — development-only storybook
```

### RPC protocol

- JSONL records are LF-delimited; command IDs correlate replies.
- Subprocesses have independent process groups. Lifecycle control must not leave orphan descendants.
- The thin RPC client does not rely on Pi's private client implementation.
- Parent-to-child messages always use `prompt` with `streamingBehavior: "steer"`, covering both idle and running states without fallback:
  - Idle: start a new model turn.
  - Running: queue after the current response and tool batch.
  - Do not send a bare `steer` command to an idle child: it may acknowledge the command without starting work.

### Lifecycle

```text
queued → running ──→ completed (notify)
                  ├── failed (API error/crash; notify)
                  └── stopped (limit: notify; agent_stop: no notification)
       persistent: completed → idle (resident, zero model tokens) → stopped
```

- Readiness is established by the prompt preflight response.
- Root children are persistent by default; children spawned inside a sub-agent are not. Callers may override this. Residency lasts only for the host session. Background spawning is root-only.
- Idle means a resident RPC process without an active model turn. Notifications and widget rows identify it as idle; it remains addressable until stopped or host exit.
- Stop closes stdin for orderly shutdown and marks `stoppedByControl` to suppress a new completion notification.
- Failures and limit stops produce error tool results, consistent with bash exit/cancellation reporting.
- Reload and session replacement (`/new`, `/resume`, `/fork`) dispatch `session_shutdown` to the old extension runtime before replacing it. The registry closes this runtime's children for every reason: the old session's inbox is closed, so a surviving child could never deliver again. Host crashes also close their stdin. Cleanup is process-local, so multiple Pi instances do not share lifecycle state.

### Message model

- IDs are short generated names (`max`, `zoe`, `kai`), not tree paths. A parent owns the references returned by its spawns.
- Model-facing references, card titles, and widget rows use `@max`. Input accepts the optional leading `@`; routing strips it once. Sender prefixes such as `[from max]` retain the bare ID.
- `agent_send` addresses only an exact direct-child ID or `@parent`. Unknown targets fail explicitly. There is no automatic forwarding or route discovery.
- When nested communication is enabled, cross-level forwarding is decided by each intermediate parent. The mechanism makes no routing decisions for the model.
- Prompts and sender prefixes disclose the available references. RPC message payloads remain plain text.

### Channels

Reuse existing transport without new endpoints:

```text
parent → child: RPC prompt with streamingBehavior="steer"
child → parent: extension_ui_request / setStatus, key "pi-subagent-msg"
                best-effort, fire-and-forget, no receipt
active message: pi.sendMessage(deliverAs="steer", triggerTurn=true)
automatic result: batched turn_end / agent_before_settle entries;
                  separate idle cards and one steer wake
```

- Messaging uses in-memory event flow, not sockets, file polling, or a query tool.
- A running parent consumes injected messages without preemption; an idle parent may start a model turn.
- Each `AgentProcess` owns a client connection, so the connection identifies the child sending an event.
- `PI_SUBAGENT_AGENT_ID` identifies a child process. Only instances below `maxDepth` register `agent_spawn` and `agent_stop`; every child registers `agent_send`, and one at the limit reaches only `@parent`. Final replies return automatically and carry blocking questions and the final report; `agent_send` to `@parent` carries only non-blocking questions.
- Each `@parent` message is injected with its own `triggerTurn`, outside the completion inbox, so an idle parent spends a model turn on each one. The child prompt therefore rules out progress updates.

### Transport validation (2026-08-10)

| Assumption | Observed result |
|---|---|
| A child extension injects `pi.sendMessage(deliverAs="steer", triggerTurn=true)` into its session | Starts another turn |
| `triggerTurn` wakes an idle agent | Confirmed |
| Child `extension_ui_request` events reach the parent RPC client | Delivered without protocol-level throttling or deduplication |
| Unknown RPC event types | Ignored without failing the client |
| Bare `steer` to an idle session | Acknowledged but does not start work; do not use this path |
| `prompt` with `streamingBehavior="steer"` to an idle session | Starts work |
| `prompt` with `streamingBehavior="steer"` to a running session | Queues without rejecting the prompt |

### Completion notifications

- Ready results first enter a session-scoped inbox. A busy parent receives the whole ready batch after its current response and tool batch, before the next model call: the steering delivery point. `turn_end` appends custom entries and requests at most one continuation; `agent_before_settle` handles the final boundary. Do not interrupt tools or generation, wait for unfinished children, use the follow-up queue, or depend on the global steering consumption mode.
- Idle delivery uses one `setImmediate` to collect ready callbacks. Append the earlier cards without triggering a turn, then let the final card start one run with `deliverAs: "steer", triggerTurn: true`. Card count is not model-call count.
- Model content contains `{kind: "final_reply", completion_id, status, agent_id, result, session_path}` and, for persistent completion, `idle: true`. `kind` tells the parent this is the turn's final reply (a final report or a blocking question), as opposed to a mid-turn `{kind: "non_blocking_question", agent_id, question}` from `agent_send` to `@parent`. A foreground spawn's final reply is the `agent_spawn` tool result itself.
- A completion ID combines a process-instance UUID and settlement sequence. Deduplicate the event, not its text or agent ID. Preserve different turns, including acknowledgements. A deliberate stop neither emits a new completion nor retracts queued results.
- On abort/error, save results without requesting continuation. Later idle results remain silent until another accepted run. Shutdown/session replacement cancels callbacks; senders from the old session cannot write to the new one.
- Parameter definitions explain parameters. Tool descriptions/snippets explain calls. Coordination rules have one source in [`skills/pi-subagents-workflow/SKILL.md`](skills/pi-subagents-workflow/SKILL.md), not duplicated tool guidelines. `package.json` declares and ships the skill; whole-package discovery advertises its name, description, and path before tool activation, while the body is read on demand. A process that cannot spawn removes the skill from its system prompt in `before_agent_start`. Model-facing guidance uses English.
- The child prompt suffix explains both channels up. The final reply carries the final report and blocking questions: ask and end the reply when blocked on missing information, return the result directly when finished, and do not send a duplicate completion report. `agent_send` to `@parent` carries only non-blocking questions: send and keep working; never blocking questions, progress updates, or results. A foreground spawn adds that the parent reads mid-turn messages only after the reply ends, since it is blocked in its tool call until then, so non-blocking questions go in the reply too. Every child has `agent_send`: the extension adds it to any `tools` allowlist, on spawn and on revive. The skill adds no preset roles, enforced workflow, or default budgets.
- Timely delivery prevents follow-up queue delay. It cannot guarantee a report remains current after subsequent code changes. Do not filter result text or overwrite one child's earlier reports.
- Card-only rendering information stays in `details`, outside model context.
- Spawn failure already returns an error tool result and therefore does not also emit a completion notification.
- Persistent follow-up turns return through `onIdle → completionNotification → inbox`, just like the initial turn. Otherwise `agent_send` would report delivery without returning the answer. Deliberate stops remain silent; failed follow-ups report failure.
- A turn's answer goes to the parent when the parent started that turn or messaged during it. A user side-chat message from the agent view in the same turn does not cancel this; a turn only the user started stays in the child's session.
- The user can stop a live child from its agent view (Ctrl+X twice). Unlike `agent_stop`, the parent did not ask for this, so a parent still waiting on the turn receives a `stopped` completion; an idle child stops silently.

### Graceful limits

- No default deadline. The optional `timeoutMs` is the only elapsed-time limit. It bounds each turn: the first one and every wake of a resident agent. A timed-out wake reports `stopped` and the agent closes; `agent_send` resumes it from its session.
- No token limit. `get_session_stats` supplies display-only usage information.

### Session storage

- Child sessions live outside Pi's standard session tree, keeping `pi -r` uncluttered. Saved sessions are never deleted.
- Spawn passes `--name`, capped at 80 characters. The label affects display, not agent behavior.
- Review a saved session with `pi --session <path>`.

### Nesting

`PI_SUBAGENT_DEPTH` and `PI_SUBAGENT_MAX_DEPTH` propagate the main session's depth limit. At default `maxDepth=1`, a child's only agent tool is `agent_send`, restricted to `@parent`, used only for non-blocking questions, and active from the start: messaging the parent is independent of spawning. Raising the limit allows eligible children to delegate and communicate along parent-child edges. Each parent registry assigns its own children's IDs.

### Single-display rule (2026-08-22)

A subtree has one display destination, determined by its anchor:

- **Foreground**: the subtree fits inside one parent tool call, so descendant counters fold into that tool card (`done n/total · n running · …`) rather than the widget. Nested activity still appears in the card body. Counters cover descendants, not the direct child whose own output occupies the card.
- **Background**: the child's lifetime extends beyond the tool call, so it and its descendants appear in widget rows with depth indentation.

All nodes report all spawns, foreground and background. Intermediate nodes forward the event unchanged except for incrementing depth. The root chooses card folding or widget display. Omitting foreground telemetry previously hid foreground descendants of background children and left escaped background descendants with invalid indentation.

Children can only spawn foreground work, so no detached edge appears inside their subtrees. Root background edges and their descendants remain represented in the widget.

A persistent foreground child may outlive its completed tool card. Once execution settles, `cardClosed` prevents new descendant events from folding into the frozen card; later activity goes to the widget.

**Removing a parent ends its live display subtree.** Process exit ends descendant telemetry, so an add event carries its direct `parent` ID throughout forwarding. `AgentWidget` recursively marks remaining live descendants stopped when their parent is removed, retaining roster entries for review. Previously those descendants could remain as permanent spinners after their processes had exited.

**Shared vocabulary:** `counterParts` supplies foreground subtree counters; `agentTitle` supplies `@id — label`; shared card helpers supply status icons. Consumers choose status tones without duplicating the vocabulary.

### Foreground-only child spawning; persistent residency at every level (2026-08-22)

A child's lifetime is bounded by its parent's foreground wait. Detached descendants would either die when that wait returns or force extra acknowledgement turns that overwrite the actual answer and leave counters inconsistent. Therefore a child schema omits `run_in_background` (`buildSpawnParamsSchema(HAS_PARENT)`), and its description explains foreground delivery. Execution also rejects unexpected background arguments. The earlier mechanism that waited for detached descendants before returning is no longer needed.

Persistent residency means the process remains available after a completed turn, only until its host session ends. Root residents close with their root host; nested residents close with their parent. This supports repeated `agent_send` calls within the parent's lifetime without promising independent survival.

### Pi tool-result error compatibility

- Symptom: an extension returning `{isError: true}` can still receive a successful tool-card background.
- Cause: pi's normal-return path in `executePreparedToolCall` sets `isError: false`; thrown failures follow a different path. This is a host compatibility concern, not a separate agent protocol.
- Workaround: error results carry `details.error`. A `tool_result` hook restores `isError: true` through the supported result override while preserving details. Throwing instead would lose those details.

## Outside this scope

- Predefined agent types: callers define the agent through parameters.
- Scheduling.
- Worktree isolation.
- A separate fleet-management framework; the native agent view and saved-session attach provide inspection. The view's footer reuses pi's `FooterComponent` with the child's data (session-file usage totals, live rpc model/thinking/context, and the child's own extension statuses), so it matches the main footer; the view's key line comes last.
- Concurrency limits or a worker queue: each background child is a process.
- Result polling/query tools: completion is pushed once.
- Windows support: process and pipe lifecycle assumes POSIX.
- Session deletion: retain child conversations for review.

## Other notes

- Load the extension through the standard extension directory or `pi install`. Nested Pi instances use the same extension, subject to the inherited depth limit.
- In headless mode (`pi -p`), host exit closes child stdin. Background workflows require a long-lived host session.
