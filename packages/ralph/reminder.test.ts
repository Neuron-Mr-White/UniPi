import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRalphLoopReminder,
  latestRalphReminder,
  RALPH_REMINDER_TYPE,
} from "./reminder.ts";

const state = {
  name: "cache-rollout",
  iteration: 3,
  maxIterations: 10,
  taskFile: ".unipi/ralph/cache-rollout.md",
  itemsPerIteration: 2,
};

function context(branch: any[]) {
  return { sessionManager: { getBranch: () => branch } } as any;
}

function custom(content: string) {
  return {
    type: "custom_message",
    customType: RALPH_REMINDER_TYPE,
    content,
    id: "r1",
    parentId: null,
    timestamp: "2026-08-14T00:00:00.000Z",
    display: false,
  };
}

describe("Ralph append-only reminder snapshots", () => {
  it("is deterministic and explicitly supersedes older reminders", () => {
    const first = buildRalphLoopReminder(state);
    const second = buildRalphLoopReminder({ ...state });
    assert.equal(first, second);
    assert.match(first, /supersedes all earlier Ralph loop reminders/);
  });

  it("finds an unchanged retained snapshot for deduplication", () => {
    const content = buildRalphLoopReminder(state);
    assert.equal(latestRalphReminder(context([custom(content)])), content);
  });

  it("returns the newest retained snapshot when state changes", () => {
    const old = buildRalphLoopReminder({ ...state, iteration: 2 });
    const current = buildRalphLoopReminder(state);
    assert.equal(latestRalphReminder(context([custom(old), { ...custom(current), id: "r2" }])), current);
    assert.notEqual(old, current);
  });

  it("stops at compaction so current state is reinjected once in the new epoch", () => {
    const old = buildRalphLoopReminder({ ...state, iteration: 2 });
    const compaction = {
      type: "compaction",
      id: "c1",
      parentId: "r1",
      timestamp: "2026-08-14T00:00:01.000Z",
      summary: `folded: ${old}`,
      firstKeptEntryId: "r1",
      tokensBefore: 1000,
    };
    assert.equal(latestRalphReminder(context([custom(old), compaction])), null);
  });
});
