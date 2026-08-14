# Implement DeepSeek cache-rate fixes (94.3% → 99%+)

Follow-up to research in docs/deepseek-cache-rate-research.md. Root cause: pi rebuilds the system prompt every turn, and unipi `before_agent_start` hooks append *changing* content (Ralph iteration, milestone file, sandbox tools, memory recall) → full-prefix cache invalidation every turn.

## Goals

1. [x] **Decide with the user** what to change and how. Decisions locked: (a) Ralph → move iteration status to the latest turn message (tail), NOT the system prompt; (b) Milestone → cache, re-inject only on file change; (c) Auto-compaction → single 85% reset; (d) Sandbox → leave as-is (manual/user-driven); (e) Memory → leave as-is.

2. [x] **Implement** the chosen fixes + rebuild packages/unipi/bundled.js.

3. [x] **Benchmark before vs after** (deterministic prefix-stability). Real-API benchmark left optional (needs API key + spend).

## Implemented changes

| File | Change |
|---|---|
| packages/ralph/index.ts | `before_agent_start` now returns a hidden `message` (`unipi-ralph-loop-reminder`) instead of appending `[RALPH LOOP ... Iteration N]` to `event.systemPrompt`. System prompt stays byte-stable across turns. |
| packages/milestone/hooks.ts | Added cache keyed by file signature (size+mtime). `formatMilestoneContext` recomputed only when MILESTONES.md changes; otherwise the cached string is re-injected (byte-stable). |
| packages/compactor/src/config/schema.ts | auto-compaction default `thresholdPercent` 80 → 85. |
| packages/compactor/src/compaction/auto-trigger.ts | `AUTO_COMPACTION_DEFAULTS.thresholdPercent` 80 → 85, `repeatMinGrowthTokens` 4_000 → 32_000. |
| packages/compactor/tests/config.test.ts | Updated default assertion 80 → 85 (+ repeatMinGrowthTokens 32_000). |

Build: `npm run build` → bundled.js 1253KB (secret scan clean). Typecheck: `npx tsc --noEmit --skipLibCheck` → exit 0.

## Benchmark result (deterministic, /tmp/benchmark-cache-prefix.mjs)

20-turn simulation (ralph active, milestone file changes at turn 10):
- BEFORE (old unipi): 19/19 turns change the system-prompt prefix → ~0% stable → full cache miss every turn.
- AFTER (new unipi): 1/19 turns change (only the milestone file-change turn) → 94.7% stable.
- Improvement: 100.0% prefix misses → 5.3% prefix misses (94.7pp reduction).

Real-world mapping: each "prefix change" = one full-prefix DeepSeek cache miss (~62K uncached tokens re-billed at miss price). The Ralph fix eliminates the per-turn full miss; remaining resets are only genuine prefix changes (milestone file change, compaction, new session).

## Constraints
- Preserve each feature's original behavior/intent.
- Do not break existing tests; keep changes minimal and reversible.

## Rollout (full-release chore) — 2026-08-13

Scoped to the one real fix (Ralph). Reverted milestone caching + auto-compaction 80→85 (legitimate/avoidable resets, not unnecessary mutations).

- Commit 1: `fix(ralph)` — loop status → hidden tail message (packages/ralph/index.ts + docs/deepseek-cache-rate-research.md).
- CHANGELOG: added `## [2.4.1]` entry.
- Versions: `@pi-unipi/ralph` 2.4.0 → 2.4.1; root `@pi-unipi/unipi` 2.4.0 → 2.4.1; root dep on ralph → 2.4.1; lockfile synced.
- Commit 2: `chore: release 2.4.1`.
- Published: `@pi-unipi/ralph@2.4.1` then `@pi-unipi/unipi@2.4.1` (npm verified).
- Pushed: `upstream/main` (72f3d2b).
- Tag: `v2.4.1` created + pushed.
