/**
 * Resume injection — inject snapshot into session context post-compaction
 */

import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import type { SessionDB } from "./db.js";
import { buildResumeSnapshot } from "./snapshot.js";
import { buildAutoInjection } from "./auto-inject.js";
import { loadConfig } from "../config/manager.js";
import type { CompactorConfig } from "../types.js";

export function isSessionContinuityEnabled(config: CompactorConfig): boolean {
  return config.sessionContinuity.enabled && config.sessionContinuity.mode !== "off";
}

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

/**
 * Build the one-shot hidden context message used on the first turn after
 * compaction. Keeping this out of the system prompt preserves Pi's stable
 * prompt/history prefix for provider cache reuse.
 */
export async function buildResumeContextMessage(
  db: SessionDB,
  sessionId: string,
): Promise<BeforeAgentStartEventResult | undefined> {
  const snapshot = await injectResumeSnapshot(db, sessionId);
  if (!snapshot) return undefined;

  return {
    message: {
      customType: "unipi-compactor-resume",
      content: snapshot,
      display: false,
    },
  };
}
