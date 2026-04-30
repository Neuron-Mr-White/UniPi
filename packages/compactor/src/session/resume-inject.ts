/**
 * Resume injection — inject snapshot into session context post-compaction
 */

import type { SessionDB } from "./db.js";
import { buildResumeSnapshot } from "./snapshot.js";
import { buildAutoInjection } from "./auto-inject.js";
import { loadConfig } from "../config/manager.js";

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

  // Auto-injection: add behavioral state after compaction (if enabled)
  const config = loadConfig();
  let fullSnapshot = snapshot;
  if (config.pipeline.autoInjection) {
    const autoInjection = buildAutoInjection(events);
    if (autoInjection) {
      fullSnapshot = `${snapshot}\n\n${autoInjection}`;
    }
  }

  db.markResumeConsumed(sessionId);
  return fullSnapshot;
}
