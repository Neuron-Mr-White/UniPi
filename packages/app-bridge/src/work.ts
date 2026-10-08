/**
 * Work adapter (UNI-160 "session control centre" §4 Running) — re-exports
 * the shared work list from @pi-unipi/core (UNI-126 "one TUI tray" moved the
 * implementation there so the TUI tray/dock can share it too). Kept as a
 * thin module here so existing imports (`./work.js`) and the bridge's wire
 * shape stay stable.
 */
export {
  listWorkItems,
  runningWorkCount,
  stopWorkItem,
  backgroundWorkItem,
  workLogPage,
  type WorkItem,
  type WorkDot,
} from "@pi-unipi/core";
