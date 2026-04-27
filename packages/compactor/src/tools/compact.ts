/**
 * compact tool — trigger manual compaction with stats
 */

import type { CompactionStats } from "../types.js";

export interface CompactResult {
  success: boolean;
  stats?: CompactionStats;
  message: string;
}

export function compactTool(): CompactResult {
  // The actual compaction is handled by the session_before_compact hook.
  // This tool just signals the intent and returns current stats.
  return {
    success: true,
    message: "Compaction triggered. Stats will be available after next compact event.",
  };
}
