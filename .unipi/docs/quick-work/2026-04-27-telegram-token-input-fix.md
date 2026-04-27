---
title: "Fix Telegram Token Input - Paste and Arrow Keys"
type: quick-work
date: 2026-04-27
---

# Fix Telegram Token Input - Paste and Arrow Keys

## Task
Fix two issues with the token input field in the Telegram setup overlay:
1. Arrow keys (left/right) added characters to the token instead of moving cursor
2. Pasting was difficult due to incomplete bracketed paste handling

## Root Cause
The manual input handler had two bugs:

### Arrow Keys
Arrow key sequences (`\x1b[C` for right, `\x1b[D` for left) were not fully detected. The code caught `\x1b` alone (Escape) but let the full sequences through to the else branch, where regex stripped escape chars and left `C`/`D` to be appended.

### Bracketed Paste
Terminal bracketed paste mode sends: `\x1b[200~content\x1b[201~`
The code only ignored `\x1b[200~` (start marker) but didn't:
- Detect the end marker `\x1b[201~`
- Buffer content between markers
- Process the complete pasted content

## Changes
- `packages/notify/tui/telegram-setup.ts`:
  - Added `isInPaste` and `pasteBuffer` state properties
  - Added bracketed paste detection and buffering in `handleInput`
  - Extracted `processTokenInput()` method that filters escape sequences (`\x1b[`)
  - Valid token characters: `[0-9:A-Za-z_-]`

## Verification
- `npm run typecheck` passed
- Committed as `c176b19`

## Notes
- pi-tui's `Input` component handles all this correctly (reference: `input.js`)
- This fix is a targeted patch; a proper refactor to use `Input` component would be more robust
- The `\x1b[` filter catches arrow keys, function keys, and other CSI sequences
