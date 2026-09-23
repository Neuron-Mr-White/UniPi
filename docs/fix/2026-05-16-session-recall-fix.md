---
title: "Session Recall Empty History — Quick Fix"
type: quick-fix
date: 2026-05-16
---

# Session Recall Empty History — Quick Fix

## Bug
`/unipi:session-recall <query>` always warned `No session history available for search.` and `/unipi:compact-recall` showed the new command's usage warning.

## Root Cause
The compactor cached recall blocks from `ctx.messages` during `before_agent_start`, but Pi's `before_agent_start` context does not expose `messages`. After compaction, the compacted LLM context also omits raw pre-compaction messages, so recall could not search the history users expected.

## Fix
Recall now builds searchable blocks from `ctx.sessionManager.getBranch()`, which contains the append-only active session path including raw messages before compaction. Slash commands and tools prefer this live branch and fall back to cached blocks when needed. The deprecated `/unipi:compact-recall` alias now shows its own usage message with a deprecation hint.

### Files Modified
- `packages/compactor/src/session/recall-blocks.ts` — added session-branch-to-recall-block extraction.
- `packages/compactor/src/commands/index.ts` — use live branch blocks for `/unipi:session-recall` and improve alias usage.
- `packages/compactor/src/tools/register.ts` — use live branch blocks for `session_recall` / `vcc_recall` tools.
- `packages/compactor/src/index.ts` — refresh cached recall blocks from session branch instead of nonexistent `ctx.messages`.
- `packages/compactor/tests/recall-blocks.test.ts` — added regression coverage for compacted raw-message recall.

## Verification
- `npm run typecheck` passes.
- `bun test packages/compactor/tests/recall-blocks.test.ts` passes.
- `bun test packages/compactor/tests` has one unrelated config-environment failure (`overrideDefaultCompaction` is true in local global config); new recall tests pass.

## Notes
The recall implementation now matches the user expectation that content omitted from the compacted prompt remains searchable through recall.
