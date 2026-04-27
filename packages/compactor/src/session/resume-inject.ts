/**
 * Resume injection — inject snapshot into session context post-compaction
 */

import type { SessionDB } from "./db.js";
import { buildResumeSnapshot } from "./snapshot.js";

export async function injectResumeSnapshot(
  db: SessionDB,
  sessionId: string,
  opts?: { searchTool?: string },
): Promise<string | null> {
  const resume = db.getResume(sessionId);
  if (!resume || resume.consumed) return null;

  const events = db.getEvents(sessionId, { limit: 1000 });
  const stats = db.getSessionStats(sessionId);
  const snapshot = buildResumeSnapshot(events, {
    compactCount: stats?.compact_count ?? 1,
    searchTool: opts?.searchTool ?? "ctx_search",
  });

  db.markResumeConsumed(sessionId);
  return snapshot;
}
