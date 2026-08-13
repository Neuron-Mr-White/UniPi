# DeepSeek Cache Rate Research: 94.3% → 99%+

**Date:** 2026-08-13
**Status:** Complete (research only — no code changed)

## Your numbers, decoded

| Metric | Value |
|---|---|
| Requests | 8,019 |
| Cache hits | 7,560 → **94.3% request-level** |
| Total input tokens | 1,062,059,895 |
| Cached tokens | 1,033,300,096 → **97.3% token-level** |
| Misses | **459 requests** |
| Wasted (uncached) tokens | ~28.7M |
| **Uncached tokens per miss** | **~62.7K** |

**Key diagnostic:** each miss re-sends ~62K tokens uncached. That is a *full-prefix* miss — not the normal small "new tail" of a cache hit. Something is changing the **entire prompt prefix** between requests, forcing DeepSeek to re-bill the whole context at miss (non-cached) price. That's the ~5x cost multiplier.

---

## Part 1 — How DeepSeek-Reasonix hits 99.82%

DeepSeek's prefix cache lives **server-side**. The hit rate is decided entirely by the **client** keeping the request prefix byte-identical across calls. Reasonix (the Go `main-v2` line) makes this a hard invariant:

1. **Append-only canonical transcript.** History is *never* rewritten between compactions — no pruning, no snipping, no auto-editing of old messages. Any rewrite invalidates the cache from that point onward.

2. **Byte-stable system prompt + tool schemas.** System prompt, memory prefix, and tool schemas are treated as immutable. All dynamic content (memory recall, per-turn instructions, goal context, sandbox notes) is appended to the **user turn**, never to the system prompt or tools.

3. **One rare cache-reset point.** Compaction triggers only at `compact_ratio` (default **0.85** = 85% of context window). Between compactions the session grows *prepend-only*.

4. **Stable compaction shape.** `stable prefix + ONE structured digest (≤16K) + recent verbatim tail (10% window, 32K–96K)`. No digest chaining — each fold re-derives from the canonical transcript, so digests never compound drift.

5. **Tool results bounded at write time.** First-visible content capped at 32KB; full text goes to `RawContent`, which is **stripped from provider serialization** so it never enters the cache hash.

6. **Deterministic ordering.** Tool schemas are stable; no random fields, no UUIDs, no timestamps in the prompt.

7. **Two-model work runs in separate sessions.** Switching models *inside* one conversation breaks the prefix, so planner/executor each get their own cache-stable session.

8. **No date/time/clock in the system prompt.** (Nothing like "today is 2026-08-13" that would break the cache daily.)

9. **Cache stability is a design invariant.** Every feature is gated on: *"does this mutate the cacheable prefix?"* — if yes, it goes into the user turn or a separate session.

---

## Part 2 — Why pi/unipi is at 94.3% (root causes)

### The architectural difference

In pi, the system prompt is **rebuilt on every turn**, not once per session:

- `prompt()` → `createTurnState()` re-runs the `systemPrompt` function **every turn** (`agent-harness.js`, and again in `prepareNextTurn`).
- `executeTurn()` fires `before_agent_start`, and the extension runner **chains handlers**, each appending to `event.systemPrompt` (`runner.js` `emitBeforeAgentStart`).

So any unipi hook that appends **non-constant** content mutates the whole system prompt → the *entire prefix* becomes a cache miss next turn. That's exactly the ~62K-uncached-tokens-per-miss signature.

### Concrete culprits (all in `packages/unipi/bundled.js`)

**A. Ralph loop hook (~line 7746) — likely the #1 cause**

```js
systemPrompt: event.systemPrompt + `
[RALPH LOOP - ${state.name} - Iteration ${iterStr}]`
```

`iterStr = "${iteration}/${maxIterations}"` changes **every turn** in a ralph loop. Ralph loops are used constantly. Each turn invalidates the full prefix.

**B. Milestone hook (~line 26304)**

```js
const context = formatMilestoneContext(milestonesPath);
return { systemPrompt: currentPrompt + "\n\n" + context };
```

Re-reads `MILESTONES.md` **every turn** and appends it to the system prompt. Any checkbox the agent checks mid-session changes the prefix.

**C. Workflow sandbox hook (~line 7140)**

Calls `pi.setActiveTools(...)` and appends a sandbox block. Changing the active tool list reorders/rewrites the `tools` array → prefix change (plus the system prompt append).

**D. Memory recall hook (~line 8923)**

Injects the "🧠 Memory System Active" block as a message — good — but `recallDone` is reset on `session_compact`, so it re-injects right after a compaction, compounding that reset. The memory title list also changes as memories are stored.

**E. Auto-compaction (cocoindex `turn_end` → `ctx.compact()`, plus pi-core compaction)**

Compaction rewrites history → full cache reset. If the auto-compaction threshold is low, this fires more often than Reasonix's single 85% reset.

**F. Cold starts.** Every new session begins cold (first request = full miss). Many short sessions amplify the miss rate.

**G. The giant `<available_skills>` block lives in the system prompt.** It's thousands of tokens; any skill install/update/removal between sessions is an expensive full-prefix change.

**H. System prompt rebuilt every turn** is itself a latent bug source — any non-determinism (config reload, file read, map ordering) becomes a silent cache break. Reasonix builds the prompt once and freezes it.

---

## Part 3 — What to change (ordered by impact)

1. **Move Ralph iteration status out of the system prompt.** Inject `[RALPH LOOP … Iteration N]` as a per-turn **user message** (or transient steering message), never into `event.systemPrompt`. Highest-impact fix.

2. **Make milestone context cache-stable.** Either inject it as a user-turn message (append-only, only the tail is uncached), or cache the read and re-inject only when the file's mtime/hash changes. Stop re-appending it to the system prompt every turn.

3. **Stop mutating active tools mid-session for sandbox.** Emit "blocked tools" as a user-turn instruction instead of `setActiveTools()`, so the `tools` array stays byte-stable.

4. **Keep memory recall append-only.** Don't reset `recallDone` on `session_compact`, and don't let the memory title list churn the prefix mid-session.

5. **Align auto-compaction to Reasonix's single 85% reset.** One compaction per session boundary, producing a stable `prefix + one summary + recent tail` shape — not frequent multi-event compaction.

6. **Build the system prompt once per session and cache it.** Rebuild only on explicit events (tool set change, skill change, model change). Eliminates the whole class of per-turn rebuild drift.

7. **Adopt the Reasonix invariant as a rule:** *dynamic per-turn context goes in the user turn, never in system prompt or tool schemas.* Audit every `before_agent_start` hook against it.

8. **Freeze tool ordering and schemas.** Guarantee deterministic `activeTools` order; no re-registration/reordering during a session.

9. **Shrink the prefix.** Move the `<available_skills>` block out of the system prompt or to a lazily-loaded "index line only" form (Reasonix: *"bodies load on demand; only the index line is cache-stable"*).

10. **Reduce cold starts.** Prefer fewer, longer sessions to stay inside DeepSeek's cache TTL.

11. **Add cache-hit observability.** Log per-request hit/miss and prefix length (Reasonix treats cache hit rate as the key signal). Currently only the aggregate is visible in OmniRoute — per-request visibility is needed to catch regressions.

---

## Bottom line

The misses are *full-prefix* invalidations, not normal tail growth. The mechanism is pi's per-turn system-prompt rebuild + unipi's dynamic `before_agent_start` injections (Ralph iteration, milestone file, sandbox tool mutation). Fixing #1–#3 alone should move the cache rate from 94.3% into the 99%+ range.
