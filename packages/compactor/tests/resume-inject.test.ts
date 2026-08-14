import { describe, expect, it } from "bun:test";
import { buildResumeContextMessage, isSessionContinuityEnabled } from "../src/session/resume-inject.js";
import { DEFAULT_COMPACTOR_CONFIG } from "../src/config/schema.js";
import type { StoredEvent } from "../src/types.js";

const EVENT: StoredEvent = {
  id: 1,
  session_id: "session-1",
  type: "decision",
  category: "decision",
  priority: 1,
  data: "Preserve the provider-cache prefix",
  project_dir: "/tmp/project",
  attribution_source: "test",
  attribution_confidence: 1,
  source_hook: "test",
  created_at: "2026-08-13T00:00:00.000Z",
  data_hash: "decision-hash",
};

function createResumeDb() {
  let consumed = false;
  let consumeCalls = 0;

  const db = {
    getResume: () => ({ snapshot: "stored", event_count: 1, consumed: consumed ? 1 : 0 }),
    getEvents: () => [EVENT],
    getSessionStats: () => ({ compact_count: 2 }),
    markResumeConsumed: () => {
      consumed = true;
      consumeCalls++;
    },
  };

  return {
    db,
    get consumeCalls() {
      return consumeCalls;
    },
  };
}

describe("post-compaction resume context", () => {
  it("honors disabled and off continuity settings", () => {
    const enabled = structuredClone(DEFAULT_COMPACTOR_CONFIG);
    expect(isSessionContinuityEnabled(enabled)).toBe(true);

    const disabled = structuredClone(DEFAULT_COMPACTOR_CONFIG);
    disabled.sessionContinuity.enabled = false;
    expect(isSessionContinuityEnabled(disabled)).toBe(false);

    const off = structuredClone(DEFAULT_COMPACTOR_CONFIG);
    off.sessionContinuity.mode = "off";
    expect(isSessionContinuityEnabled(off)).toBe(false);
  });

  it("returns the snapshot as a hidden message without changing the system prompt", async () => {
    const state = createResumeDb();

    const result = await buildResumeContextMessage(state.db as any, "session-1");

    expect(result?.systemPrompt).toBeUndefined();
    expect(result?.message).toMatchObject({
      customType: "unipi-compactor-resume",
      display: false,
    });
    expect(result?.message?.content).toContain("<session_resume");
    expect(result?.message?.content).toContain("Preserve the provider-cache prefix");
    expect(state.consumeCalls).toBe(1);
  });

  it("injects only once after the resume row is consumed", async () => {
    const state = createResumeDb();

    const first = await buildResumeContextMessage(state.db as any, "session-1");
    const second = await buildResumeContextMessage(state.db as any, "session-1");

    expect(first?.message).toBeDefined();
    expect(second).toBeUndefined();
    expect(state.consumeCalls).toBe(1);
  });
});
