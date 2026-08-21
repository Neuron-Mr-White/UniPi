# Hook-by-hook prefix-cache audit (2026-08-21)

Scope: every `pi.on(...)` registration across all unipi packages, checked against
the DeepSeek Harness invariants (see `.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md`
in deepseek-harness): append-only durable history, no system-prompt/tool-set
mutation mid-epoch, volatile state as tail messages, deterministic projections.

Pi facts verified against pi-coding-agent 0.80.x source (`agent-session.js`,
`messages.js`, pi-ai `transform-messages.js` / `openai-completions.js`):

- `before_agent_start` may return `systemPrompt` (per-turn replacement) — the
  single most dangerous hook surface. **No unipi package uses it.**
- `tool_result`'s `details` field never reaches the provider payload (providers
  serialize only `content` + `toolCallId` + optional `name`). Display-only.
- `context` hook may return replacement `messages` (projection). Deterministic
  filters are cache-stable; retroactive edits are not.
- `nextTurn`/`followUp` custom messages append as durable user-role entries.

## Verdict per hook

| Package | Hook | Mutation surface | Cache-safe? |
|---|---|---|---|
| memory | `before_agent_start` | returns one hidden recall-reminder custom msg, gated by `recallDone` | ✅ append-only tail, once per session/epoch |
| memory | `agent_end` | `sendMessage(nextTurn)` retro store-reminder until `storeDone` | ✅ append-only tail; accumulates by design (harness-documented trade-off) |
| memory | `session_compact` | resets `recallDone` flag only | ✅ observe |
| ralph | `before_agent_start` | hidden reminder; **dedups by content** (`latestRalphReminder`) | ✅ append-only tail; iteration counter never touches system prompt (v2.4.1 fix) |
| ralph | `agent_end` / `session_shutdown` | reads messages; state save | ✅ observe |
| compactor | `before_agent_start` | one-shot resume snapshot (`markResumeConsumed`), config load | ✅ append-only tail, exactly once per compaction |
| compactor | `turn_end` | triggers `ctx.compact()` at threshold | ✅ legitimate boundary — utility marks `history_rewritten` |
| compactor | `session_before_compact` / `session_compact` | DB bookkeeping only | ✅ observe |
| compactor | `tool_result` | returns replacement `details` (diff width clamp) | ✅ `details` never serialized to provider |
| compactor | `context` | reads `(event as any).context` | ⚠️ **dead code** — `ContextEvent` has only `messages`; property never exists, hook is inert. Cache-safe but should be deleted |
| compactor | `input` | cancels bash curl/wget, security denies | ✅ no message mutation |
| workflow | `before_agent_start` | hidden sandbox snapshot, superseding append-only (v2.6.0 fix) | ✅ |
| workflow | `tool_call` | blocks disallowed tools during sandbox | ✅ block result appends; no history edit |
| workflow | `agent_end` | lifecycle state | ✅ observe |
| milestone | `before_agent_start` | hidden milestone snapshot, append-only superseding (v2.6.0 fix) | ✅ |
| milestone | `session_start` | baseline snapshots in memory | ✅ observe |
| utility | `before_provider_request` | `prefixCache.observeRequest` only | ✅ observe-only by contract |
| utility | `model_select` / `thinking_level_select` | `markBoundary` accounting | ✅ observe (correctly treats envelope change as new cache epoch) |
| utility | `session_compact` / `session_tree` | `markBoundary` | ✅ observe |
| utility | `input` / `agent_end` / `tool_call` | badge gen, analytics | ✅ observe |
| btw | `context` | filters out `btw-note` custom messages | ✅ **deterministic pure filter** — same history → same projection; the visible sequence is identical before and after btw messages are appended, so the provider prefix is unaffected |
| btw | `session_start` / `session_tree` / `session_shutdown` | thread restore/dispose | ✅ observe |
| footer | `message_start` / `message_update` / `message_end` | TPS tracker | ✅ observe |
| subagents | `session_start` / `tool_execution_start` / `session_shutdown` | UI ctx, abortAll | ✅ observe (subagent sessions have their own cache domains) |
| info-screen | `tool_call` | tool tracking set | ✅ observe |
| mcp | `session_start` | tool registration — sorted, canonical, restart-bounded (v2.6.0 fix) | ✅ registration happens once per session; reload requires restart |
| autocomplete / cocoindex / notify / image / ask-user / updater | `session_start` | init only | ✅ no mutation |

## System-prompt / tool-set mutation sweep

- `setSystemPrompt` / `systemPrompt =` writes: only in subagents `agent-runner`
  (separate child sessions) and btw's private ResourceLoader (separate session)
  — never on the parent session.
- `setActiveTools`: only subagents `agent-runner` (child sessions).
- MCP `registerTool`/`unregisterTool`: session_start only; unregister is
  capability-detected and settings changes require restart (documented).
- No hook returns `systemPrompt` from `BeforeAgentStartEventResult`.

## Findings

1. **All hooks are prefix-cache-safe.** The v2.6.0 discipline holds: every
   injected context is an append-only hidden tail custom message, every
   observation path is read-only, and the only mid-session history rewrites
   (compaction) are correctly marked as cache boundaries by utility.
2. **Dead code found:** compactor `context` hook (packages/compactor/src/index.ts
   ~line 476) reads a nonexistent `event.context` property — the sanitizer
   branch can never fire. Recommend deletion (candidate for ponytail-cuts).
3. Documented trade-off (no action): memory retro-reminder and ralph iteration
   reminders accumulate in history until consumed/complete. This is the
   harness-endorsed pattern — paid once, cached thereafter, folded by
   compaction.
