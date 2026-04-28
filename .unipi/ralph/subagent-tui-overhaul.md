## Subagent TUI Overhaul — Following tintinweb/pi-subagents patterns

### Goal
Overhaul the subagent TUI to match tintinweb's excellent UX patterns: rich tool rendering, notification widgets, finished agent lingering, overflow handling, status bar, activity grouping, conversation viewer, and proper pi-tui utils.

### Files modified
- `packages/subagents/src/widget.ts` — Widget improvements (lingering, overflow, status bar)
- `packages/subagents/src/index.ts` — renderCall, renderResult, registerMessageRenderer, conversation viewer
- `packages/subagents/src/types.ts` — Add NotificationDetails type
- `packages/subagents/src/conversation-viewer.ts` — NEW: Live scrolling conversation viewer

### Tasks

- [x] 1. Widget: Add finished agent lingering (1 turn success, 2 turns error), overflow handling with priority (running > queued > finished), status bar integration
- [x] 2. Widget: Use `truncateToWidth` from `@mariozechner/pi-tui` instead of custom ANSI truncation
- [x] 3. Widget: Improve activity description grouping (count occurrences: "reading 3 files" not "read, read, read")
- [x] 4. Types: Add NotificationDetails interface for message renderer
- [x] 5. Index: Add `renderCall` and `renderResult` to spawn_helper tool for rich inline state rendering
- [x] 6. Index: Register `subagent-notification` message renderer for styled completion boxes
- [x] 7. Index: Add ConversationViewer component with live scrolling overlay
- [x] 8. Index: Wire conversation viewer to get_helper_result via `view: true` parameter
- [x] 9. Test: Build and verify no type errors — all 34 tests pass

### Status: COMPLETE
