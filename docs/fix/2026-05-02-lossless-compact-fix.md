---
title: "Compaction command not working — Fix Report"
type: fix
date: 2026-05-02
debug-report: inline (conversation-based debug)
status: fixed
---

# Compaction Command Not Working — Fix Report

## Summary
`/unipi:compact` was a no-op that never triggered compaction. Renamed to `/unipi:lossless-compact` and wired to `ctx.compact()` for immediate zero-LLM compaction.

## Root Cause
1. The command handler called `compactTool()` — a function that just returned `{ success: true, message: "..." }` without calling Pi's `ctx.compact()` API.
2. The `compact` tool had the same issue — incrementing a counter but never triggering compaction.
3. `overrideDefaultCompaction` was `false` in user config, meaning even auto-compaction events bypassed our pipeline.

## Changes Made

### Files Modified
- `packages/compactor/src/commands/index.ts` — Renamed command to `/unipi:lossless-compact`, wired `ctx.compact({ customInstructions: COMPACTOR_INSTRUCTION })` with `onComplete`/`onError` callbacks. Old `/unipi:compact` kept as deprecated alias.
- `packages/compactor/src/tools/register.ts` — Updated `compact` tool description to guide users toward the command. Removed misleading counter increment and `compactTool()` import.
- `packages/core/constants.ts` — Added `LOSSLESS_COMPACT` to `COMPACTOR_COMMANDS`.
- `packages/autocomplete/src/constants.ts` — Added `unipi:lossless-compact` to command registry and descriptions. Updated `unipi:compact` description to show deprecation.
- `~/.unipi/config/compactor/config.json` — Set `overrideDefaultCompaction: true` so our zero-LLM pipeline handles all compaction events.

### Pattern Used
Exact port of pi-vcc's working pattern from `src/commands/pi-vcc.ts`:
```typescript
ctx.compact({
  customInstructions: COMPACTOR_INSTRUCTION,  // "__compactor__"
  onComplete: () => { /* show stats */ },
  onError: (err) => { /* handle errors */ },
});
```

## Verification
- ✓ TypeScript compilation clean (`tsc --noEmit`)
- ✓ Autocomplete sorting tests pass (37/37)
- ✓ `overrideDefaultCompaction` set to `true` in live config

## Risks & Mitigations
- **Two commands do the same thing**: `/unipi:compact` is kept as deprecated alias → low risk, will be removed later
- **`overrideDefaultCompaction: true`**: Our compactor now handles ALL compaction events (auto + manual). If our pipeline has bugs, it could affect auto-compaction → mitigated by `buildOwnCut` returning `null` on too-few-messages, which lets Pi's default handle edge cases
- **`compact` tool still exists**: Can't call `ctx.compact()` from tool context → documented that users should use the command instead

## Follow-up
- [ ] Remove `/unipi:compact` deprecated alias after transition period
- [ ] Consider removing `compactTool()` from `src/tools/compact.ts` entirely
- [ ] Update CHANGELOG.md
