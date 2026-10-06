import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { bus, resetBusForTests, UNIPI_EVENTS } from "@pi-unipi/core";
import { NudgeStash, ownerEventClearsStash } from "../engine/nudge-stash.js";
import { OwnerCoordinator, type OwnerEvent } from "../owner.js";
import { lhStateFrom } from "../lh-state.js";

function harness(): { coordinator: OwnerCoordinator; events: OwnerEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), "lh-stash-owner-"));
  const events: OwnerEvent[] = [];
  const coordinator = new OwnerCoordinator({
    statePath: () => join(dir, "state.json"),
    onChange: (_snapshot, event) => {
      events.push(event);
      // Publish to the bus the way index.ts does (display half is a literal;
      // these tests assert owner/lastStop only).
      bus.emit(UNIPI_EVENTS.LH_STATE, lhStateFrom(coordinator.getActive(), coordinator.getParked(), coordinator.lastStop(), "none"));
    },
  });
  return { coordinator, events };
}

beforeEach(() => resetBusForTests());

test("finished and suspended owner events clear the stash marker", () => {
  assert.equal(ownerEventClearsStash({ type: "finished" }), true);
  assert.equal(ownerEventClearsStash({ type: "suspended" }), true);
  assert.equal(ownerEventClearsStash({ type: "activated" }), false);
  assert.equal(ownerEventClearsStash({ type: "resumed" }), false);
  assert.equal(ownerEventClearsStash({ type: "restored" }), false);
});

test("R1: owner finish clears an undelivered hint (user stop)", () => {
  const stash = new NudgeStash();
  const { coordinator, events } = harness();
  stash.put("continue the hint");
  coordinator.activate("goal", "objective");
  coordinator.finish("paused(user_requested)");
  const cleared = events.some((event) => ownerEventClearsStash(event));
  assert.equal(cleared, true);
  if (cleared) stash.take();
  assert.equal(stash.peek(), null, "a stale hint must not outlive its owner");
});

test("R1: finish THEN wrap-up put → wrap-up survives (continuation order)", () => {
  const stash = new NudgeStash();
  const { coordinator, events } = harness();
  coordinator.activate("goal", "objective");
  coordinator.finish("complete(verifier_met)");
  for (const event of events) {
    if (ownerEventClearsStash(event)) stash.take();
  }
  stash.put("WRAP_UP_PROMPT");
  assert.equal(stash.peek(), "WRAP_UP_PROMPT", "wrap-up is put after the stop and must be delivered");
});

test("R1: a parked owner clears the stash too", () => {
  const stash = new NudgeStash();
  const { coordinator, events } = harness();
  coordinator.activate("goal", "objective");
  stash.put("hint");
  coordinator.suspend("paused(user_requested)");
  assert.equal(events.at(-1)?.type, "suspended");
  if (ownerEventClearsStash(events.at(-1)!)) stash.take();
  assert.equal(stash.peek(), null);
});

test("R2: suspend publishes a paused stop on the bus", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "objective");
  coordinator.suspend("paused(user_requested)");
  const status = bus.get(UNIPI_EVENTS.LH_STATE);
  assert.equal(status?.owner?.status, "parked");
  assert.equal(status?.lastStop?.kind, "paused", "paused goals stop via suspend, not finish");
  assert.equal(typeof status?.lastStop?.at, "number");
});
