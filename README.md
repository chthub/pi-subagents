# pi-subagents

[English](README.md) | [Chinese](README.zh.md)

**A minimal, complete sub-agent framework for pi.**

Three operations — spawn, send, stop — backed by isolated contexts, parallel execution, automatic results, resumable sessions, and a native agent view. Complete lifecycle, minimal interface: you define the work; the framework handles the agents.

Built as a pi extension, with no additional runtime dependencies beyond pi's host-provided packages. Tested against pi 1.1.0.

```
You:  Research this project's database schema for me
  → pi calls agent_spawn, spawns a resident `pi --mode rpc` child
  → Child works independently in its own context window
  → Result comes back; you keep chatting
```

## Why?

Pi has no built‑in sub‑agents. So heavy, parallel, or context‑heavy work crowds into your one window. pi-subagents moves that work to a child pi: the noise stays there, only the answer comes back.

## Features

- **Quiet context** — logs, search hits, and test output stay in the child's window. You get the final result, not the churn.
- **True parallel** — fire several background agents at once. Ready results are delivered together at the parent's next turn boundary, with a separate card per result. No worker queue or result tool.
- **Stay in control** — `agent_send` redirects a running agent (or wakes an idle one); `agent_stop` stops its process. Final replies return automatically, carrying blocking questions and the final report; at the default depth, a child also has `agent_send` to `@parent`, for non-blocking questions only.
- **Follow-ups keep context** — a finished agent stays resident by default (idle, zero tokens; ~180 MB RAM each), and `agent_send` resumes the saved session if its process is gone or remains alive after a failed/stopped turn. A sub-agent that needs information or a decision ends its reply with the question; the parent answers with `agent_send` and the agent continues where it stopped. A non-blocking question goes to `@parent` with `agent_send` mid-turn, and the child keeps working.
- **Pi‑native** — rendering, sessions, and attach all reuse pi's own mechanisms; the cards look like built‑in tools because they are.
- **Inherit or override** — a child inherits your model and thinking level by default; override it per child. A cheap model for recon, a strong one for the build.
- **No hidden limits** — no token ceiling, no deadline, no concurrency cap by default. An optional `timeoutMs` adds a guardrail when you want one.
- **Reviewable** — every session persists and is never deleted; attach any result with `pi --session <path>`.
- **Nesting on request** — sub-agents cannot spawn by default; raise `maxDepth` in the config file to allow it.
- **Token economy** — the system side stays lean:
  - **System prompt** — tool descriptions explain operations; coordination instructions live in an on-demand skill.
  - **Notification** — the LLM sees only minimal structured data; decoration (label, usage) stays in the render layer.
  - **Results** — tail‑truncated (2000 lines / 50KB); expand any card for the full transcript.

## Design philosophy

Pi is a minimal, extensible agent harness you can make your own. pi-subagents follows that approach: provide a complete delegation mechanism without prescribing how you work.

- **Small surface, complete lifecycle.** `agent_spawn`, `agent_send`, and `agent_stop` cover delegation, follow-ups, and cancellation. Results arrive automatically; sessions persist; agents are visible and inspectable.
- **Mechanism, not a workflow engine.** No preset roles, scheduler, or enforced orchestration. Define tasks through prompts and compose the tools as needed. Optional coordination guidance lives in a skill, not runtime policy.
- **Native rather than parallel infrastructure.** Children are real pi processes. RPC, sessions, rendering, and model configuration reuse pi's capabilities instead of introducing another harness.
- **Pay only for what you use.** Agent tools activate on demand; detailed guidance is read only when needed. UI metadata stays out of model context. Nesting and timeouts are explicit choices, not hidden defaults.

Minimal means fewer concepts to learn, not an incomplete agent lifecycle. See [SPEC.md](SPEC.md) for the design contract and [docs/ui.md](docs/ui.md) for UI boundaries.

## Install

```bash
# npm (recommended)
pi install npm:@chthub/pi-subagents

# git
pi install git:github.com/chthub/pi-subagents

# local checkout (development)
pi install /path/to/pi-subagents
```

Or try it for one session: `pi -e /path/to/pi-subagents/index.ts`.

Restart pi, then tell it "ask a sub‑agent to…".

## Quick start

### Kick off a task

```
Ask a sub‑agent to analyze the auth logic under src/
```

In an interactive session, `agent_spawn` runs in the background by default: the child works in isolation and its final reply returns automatically. Request `run_in_background: false` when you want the tool call to wait and return the answer inline.

### Run several in parallel

```
Spawn three sub‑agents to look at the auth module, the database layer, and the API routes
```

Pi issues three `agent_spawn` calls in one block. Each child works independently; ready background results return automatically at the next delivery boundary. Foreground calls also run in parallel, returning their answers inline. No polling or extra result tool.

### Message or stop

```
That data‑layer sub‑agent — the approach won't work, rewrite it with composition instead
```

Pi calls `agent_send` to steer the running agent (after its current response and tool batch, before the next model request). To stop a runaway agent: "kill that background sub‑agent" → `agent_stop`. Both work on a running agent; with `persistent: true` they also work after completion — `agent_send` wakes the idle agent for follow‑ups, `agent_stop` kills it.

## Enabling the tools

The three agent tools are registered **inactive** in the main session: a conversation that never delegates carries no schema for them. In a sub-agent, `agent_send` is active from the start. The parameterless `subagent_enable` activates them for the next model request. The activation is recorded in the transcript, so a resumed session keeps them.

## Coordination skill

The package includes [`pi-subagents-workflow`](skills/pi-subagents-workflow/SKILL.md), the single source of instructions for task boundaries, parallel work, file ownership, follow-ups, and checks. It does not define preset agent roles or enforce a workflow at runtime.

When the whole package is loaded, a new session sees the skill's name, description, and path immediately, independently of `subagent_enable`. The full instructions enter context only when the model reads the skill or you invoke `/skill:pi-subagents-workflow`. Package skill filters and `--no-skills` can disable discovery. Loading only `index.ts` with `-e` does not include the packaged skill. A sub-agent that cannot spawn (at the default depth, every sub-agent) does not see the skill.

Tool descriptions explain what each call does; the skill explains how the main agent coordinates work. Children receive a short task suffix explaining automatic final replies, even if they do not load the skill.

## Agent list and agent view

Below the editor, one line per sub-agent of this conversation — running, idle, done, failed or stopped:

```
 ⠋ @jude  read-only check   12s  bash: ls -la
 ‖ @yara  keeper            idle
 ✓ @max   auth module       1m3s
 Click to open · /agents
```

- **Click a line** (fullscreen TUI mode, pi's default) or run **`/agents`** (`/agents max` opens one directly) to open that agent's full-screen view: its whole conversation rendered with pi's own components, streaming live while it runs.
- **Type in the view to talk to that agent directly.** This is a side chat: the answers stay in the agent's session and are **not** reported to the main agent. A finished agent is revived from its session file (`pi --mode rpc --session <path>`) by the first message you send, then stays resident (idle) until the main session ends or `agent_stop`. If a failed/stopped process is still alive, that new message first closes it and resumes the same session; account-limit errors therefore do not permanently block delivery after you switch accounts.
- **Hover** highlights the line under the pointer. pi turns off pointer-motion reports inside tmux, zellij and screen, so there is no hover highlight there; clicks still work.
- **The bottom of the view is pi's own footer for that agent**: working directory and git branch, its token usage, cost and context use, its model and thinking level, and the statuses its extensions set. The view's own keys sit on the last line below it.
- **Ctrl+X twice** stops a live agent (the first press asks for confirmation; any other key cancels). Its saved session stays, so a later message revives it. If the main agent is still waiting on that agent's turn, it gets a `stopped` result saying the user stopped it.
- **Esc** returns to the main conversation. PgUp/PgDn or the mouse wheel scroll; drag the right-hand scrollbar thumb or click its track to jump (fullscreen mouse input required). Dragging to the bottom follows new output again. The thumb widens from `┃` to `█` on hover or while dragging, without rewrapping the conversation; hover requires terminal pointer-motion reporting. Drag over the text to select it (double-click a word, triple-click a line); pi copies it on release, as in the main conversation. ctrl+o expands tool output.
- The list is rebuilt from the transcript on resume or `/reload` (processes don't survive those; their sessions do). `/new`, `/resume` and `/fork` stop the current conversation's sub-agents too.

## Configuration

### Config file

`<agentDir>/pi-subagents.json` (`~/.pi/agent/pi-subagents.json` unless `PI_CODING_AGENT_DIR` moves it), or the path in `PI_SUBAGENT_CONFIG`. Optional; read at startup and on `/reload`.

```json
{ "maxDepth": 1 }
```

| Key | Default | Meaning |
|---|---|---|
| `maxDepth` | `1` | Levels of agents allowed below the main session. `1`: the main session spawns sub-agents, sub-agents cannot spawn. `2`: sub-agents may spawn one more level. The main session's value applies to the whole tree; a sub-agent at the limit keeps only `agent_send`, restricted to `@parent`. |

An invalid value falls back to its default, with a warning in the TUI.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PI_SUBAGENT_SESSION_DIR` | `<agentDir>/subagent-sessions/` | Where sub‑agent session files live; set to relocate. `<agentDir>` follows pi's agent dir (`~/.pi/agent`, or pi's own `PI_CODING_AGENT_DIR`). |

The directory lives **outside** pi's standard session tree so `pi -r` (resume) stays clean. Sessions are never deleted.

### Tool reference

#### `agent_spawn` — spawn an isolated sub‑agent

| Param | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | **required** | Self‑contained task description for the sub‑agent. |
| `label` | string | required | Short label shown on the tool card, notification card, widget row, and session name. |
| `model` | string | inherited | Override the sub‑agent's model. Specified but not registered → **error, no silent fallback**. |
| `thinking` | `"off"`…`"max"` | inherited | Override thinking level; omit to run at your current session's level. |
| `tools` | string[] | all | Whitelist of tool names visible to the sub‑agent — anything else is invisible. `agent_send` is always kept; no need to list it. |
| `run_in_background` | boolean | `true` | Background (default) returns an `agent_id` immediately and delivers a completion notification carrying the final output; `false` blocks until the result is ready. When omitted in `pi -p` / json mode it runs in the foreground (the host exits after its reply). Sub-agents don't have this parameter — foreground only. |
| `timeoutMs` | number | none | Optional limit (ms) for each turn: the task itself and every later turn an `agent_send` starts. On firing, the extension aborts the turn, waits for it to settle (hard-stopping it if it doesn't), and reports it as stopped. |
| `persistent` | boolean | `true` (root) / `false` (inside a sub-agent) | Keep the child resident (idle, zero tokens) after completion so follow-ups skip the restart; `agent_stop` tears it down. With `false` it exits when done — `agent_send` still resumes it from its session. |

The final reply returns automatically and carries blocking questions and the final report. With the default `maxDepth=1`, a child's only agent tool is `agent_send` to `@parent`, for non-blocking questions only; the parent handles coordination.

#### `agent_stop` — cancel an agent task

| Param | Meaning |
|---|---|
| `agent_id` | **required** — the id `agent_spawn` returned. Cancels a running task and stops its process, or stops an idle process when explicitly requested. Graceful shutdown (stdin EOF); no new completion notification. |

Stopping neither deletes saved conversations nor rolls back file changes or cancels submitted jobs. Idle processes consume no model tokens and close with their host session.

#### `agent_send` — message an agent in the tree

| Param | Meaning |
|---|---|
| `to` | **required** — the agent id agent_spawn gave you (a short human name like `max`), or `"@parent"` to message the session that spawned you. |
| `message` | **required** — the message text; steered after the target's current response/tool batch, wakes an idle agent, or resumes a finished one from its session file (its answer arrives as a notification). |

A message to an idle child starts a new model turn; a message to an exited child resumes its saved conversation. The final reply returns automatically.

The tool addresses only direct children, or, in a sub-agent, `@parent` (its direct parent; a sub-agent at the depth limit reaches only `@parent`). The parent receives it as `{kind: "non_blocking_question", agent_id, question}`, while a completion notification carries `kind: "final_reply"`. A message to `@parent` does not end the child's turn: the parent reads it after its current response and tool batch, and its reply appears in the child's conversation once the child's current tool calls finish or its turn ends. A parent blocked in a foreground `agent_spawn` reads it only after that call returns. It does not deliver directly to siblings; cross-level coordination requires forwarding by the parent.

## Advanced

### Pick a model

```
Spawn a sub‑agent with claude-sonnet to analyze the database design
```

No model specified → inherits your current session's model. Same for `thinking` — omit it and the sub-agent runs at your current level; pass `"off"`…`"max"` to override.

Model **specified but not found** in the registry → error, no silent fallback.

### Restrict tools

```
Ask a sub‑agent to research the project structure, but only let it use read and grep
```

Sub‑agent won't see any other tools. Read‑only exploration with a cheaper model is a good pattern for research tasks.

### Child-launch integration event

Other extensions can opt child RPC processes into their own integration without a dependency on pi-subagents or a separate agent directory. Immediately before each new or revived `AgentProcess`, pi-subagents synchronously emits `pi.events.emit("pi-subagents:child-launch:v1", launch)` with fresh mutable data:

```ts
{ env: Record<string, string>, extensions: string[], error?: string }
```

`env` and `extensions` start as `{}` and `[]`. Listeners must finish synchronously (no `async`, promises, or delayed mutations). For example, inside an extension factory:

```ts
const unsubscribe = pi.events.on("pi-subagents:child-launch:v1", (data) => {
  const launch = data as {
    env: Record<string, string>;
    extensions: string[];
    error?: string;
  };
  try {
    launch.env.MY_CHILD_SYNC = "1";
    launch.extensions.push("/absolute/path/to/child-bridge.ts");
  } catch {
    launch.error = "Child integration unavailable";
  }
});
pi.on("session_shutdown", () => unsubscribe());
```

- Environment additions overlay the inherited process environment; pi-subagents' child identity/depth values win over additions. Without listeners, inherited environment behavior is unchanged. This hook does not itself change `PI_CODING_AGENT_DIR` or transfer credentials; use non-secret coordination data, not tokens.
- Extension paths are passed as deduplicated `--extension <path>` arguments on both new sessions and `--session` revivals, alongside normal Pi extension discovery. Prefer absolute paths; relative paths resolve from the child's working directory.
- Launch data is validated and copied before construction, never persisted by pi-subagents in its roster or transcripts. Invalid environment/extension types or invalid strings abort the launch rather than being coerced.
- Any supplied `error` aborts the launch, including malformed non-string values. Use sanitized generic text without paths or tokens; pi-subagents reports a generic rejection without echoing the supplied text. Emitter failures propagate.
- **Pi catches and logs listener exceptions internally.** The hook cannot detect those exceptions or await listener work. Listeners must catch their own preparation failures and synchronously set `error` to fail closed.
- Listener owners manage subscription cleanup; pi-subagents never unregisters another extension's handlers.

## How it works

Every sub‑agent is a resident `pi --mode rpc` child with a persisted session:

- **Foreground** — `agent_spawn` waits for the child to settle and returns its final output inline. Nonpersistent children then close; persistent children stay available for follow-ups.
- **Background results** — `agent_spawn` returns immediately. Each child settlement queues a `subagent-notification`. While the parent is busy, all ready results enter together after the current response and tool batch, before the next model request—the steering delivery point, implemented through `turn_end` with `agent_before_settle` as a fallback. Delivery does not interrupt generation or tools, use the follow-up queue, or depend on the global steering queue mode. Idle delivery collects the ready batch for one event-loop tick, keeps separate cards, and starts only one model run. It never waits for unfinished children. This prevents queue-induced delay, not reports becoming outdated after subsequent file changes.
- **Send/stop** — `agent_send` uses steering in both directions (after the current response/tool batch, before the next request); idle children wake. `agent_stop` closes stdin for a graceful shutdown, without a new completion notification; already queued results remain deliverable.
- **Resident idle** — by default the child stays resident after completion (idle, zero tokens). A later `agent_send` wakes it to continue the same context; `agent_stop` tears it down. The completion notification and list row carry the `idle` marker.
- **Resume/recover** — `agent_send` or a message typed in the agent view resumes a saved direct-child session when its process is gone **or is still alive in `failed`/`stopped` state**. Recovery waits for the terminal old process to exit before starting `pi --mode rpc --session <path>`; healthy running/idle processes are not restarted. The new explicit message starts the next turn, never an automatic replay of the failed request. Fresh child-launch integration data is collected after cleanup, so an integrated Codex account switch applies to the replacement. Concurrent recovery messages share one replacement; a deliberate stop or session shutdown cancels pending recovery. Parent follow-ups still report their answers; side-chat answers stay private. Delivery failures after a prompt attempt are not blindly retried.
- **Questions and deliverables** — every spawn prompt tells the child how to use its two channels up. The final reply carries the final report and blocking questions: when blocked, end the reply with the question; the parent answers with `agent_send`. `agent_send` to `@parent` carries only non-blocking questions: send the question and keep working; never blocking questions, progress updates, or results. Completed deliverables return automatically, so the child should not send a separate completion report. A foreground spawn's prompt adds that the parent reads mid-turn messages only after the reply ends, so non-blocking questions go in the reply too. Every child has `agent_send`; a `tools` allowlist never removes it.
- **Attach / review** — sub‑agent sessions live in `<agent dir>/subagent-sessions/` (see [Configuration](#configuration)). Find the session path in the main conversation and run `pi --session <path>` — or ask the LLM, the notification carries the path too.
- **Graceful turn limits (opt‑in)** — no hidden deadline: a sub‑agent runs until it finishes or is stopped unless you pass `timeoutMs`. No abrupt SIGTERM. No token limits — usage is only reported on the notification card.

## Nested sub‑agents

Off by default (`maxDepth: 1`). With a higher `maxDepth`:

A child is a full pi instance — so if you installed this extension globally, it spawns children of its own. Each level is its own process with its own context; depth multiplies startup time and token cost. You — or the model — judge when it's worth it.

The mechanism is a pure point-to-point deliverer: `agent_send` delivers to a direct child by its id (a short human name like `max`), or to `"@parent"` — and errors on anything else. Routing is the LLM's job: each agent addresses only the ids it was given, hop by hop (a grandchild reaching the root goes through its parent's LLM deciding to forward with `@parent`). Information disclosure is the only limit — a parent holds the ids of the agents it spawned; nobody knows ids they were never told.

## Costs & caveats

- **Headless children die with the host** (`pi -p`). The main process exits at the end of its reply; background children are then torn down via stdin EOF — never orphaned. Background flows (waiting for the notification, messaging, stopping) are for the always‑alive TUI session.
- **One process per child.** Foreground and background are the same resident rpc child. Many children = many processes — spawn with care.
- **One-shot results.** A process-settlement `completion_id` deduplicates each event within the live session. Different turns of the same child are preserved, even with identical text. After a parent abort/error, results are saved without requesting a restart; they remain available for the next accepted run. If the main session dies before delivery, the result survives in the child's session file (`pi --session <path>`).
- **Resident agents cost memory.** Each idle agent is a pi process (~180 MB RSS with a typical extension set) until the session ends or `agent_stop`. Pass `persistent: false` for one-off work; follow-ups still work through resume.
- **Recovery depends on the saved session.** Resume restores conversation context, not an interrupted tool's in-memory state or execution position.

## Cleanup

When pi exits, sub‑agents (running or idle) get a graceful stdin‑EOF shutdown. Sessions stay on disk for attach/replay; cleanup does not delete them.

## Development

See [AGENTS.md](AGENTS.md) for development, versioning, and publishing guidelines.

## License

MIT. Copyright notices and third-party attribution are retained in [LICENSE](LICENSE).
