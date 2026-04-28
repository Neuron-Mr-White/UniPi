---
title: "Milestone commands not executing skill — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Milestone commands not executing skill — Quick Fix

## Bug
`/unipi:milestone-onboard` only showed a notification "Loading milestone-onboard skill..." but never actually loaded or executed the skill. Also had a useless "start" autocomplete suggestion.

## Root Cause
The milestone command handlers were placeholder stubs — they called `ctx.ui.notify()` but never loaded the SKILL.md content or sent a user message. Every other workflow command follows a pattern of: load SKILL.md → build message → `pi.sendUserMessage()`.

## Fix
Rewrote `packages/milestone/commands.ts` to follow the workflow command pattern:

1. Load SKILL.md from `skills/<name>/SKILL.md`
2. Build message: `"Execute the milestone-onboard workflow."` + args + skill content
3. Send via `pi.sendUserMessage(message, { deliverAs: "followUp" })`
4. Notify user via `ctx.ui.notify()`

Also removed the dummy `"start"` autocomplete from `milestone-onboard` — it had no purpose.

### Files Modified
- `packages/milestone/commands.ts` — Complete rewrite of both handlers

## Verification
- Both commands now load their respective SKILL.md files
- Pattern matches `packages/workflow/commands.ts` handler structure
- `milestone-update` retains dynamic phase name completions from MILESTONES.md

## Notes
This is fix #5 in the milestone registration chain:
1. Wire into unipi entry point
2. npm install for symlink
3. Add UNIPI_PREFIX
4. Add to command-enchantment registry
5. **Actually execute the skill** (this fix)
