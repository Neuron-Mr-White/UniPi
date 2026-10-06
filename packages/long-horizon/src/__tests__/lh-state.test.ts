/**
 * Long-horizon sticky footer state (LH_STATE) — index.ts wiring replicated
 * against the real Gate + OwnerCoordinator + lhStateFrom publish point.
 * UNI-122: the footer must flip at owner SETTLEMENT, not at the next turn.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { bus, resetBusForTests, UNIPI_EVENTS, type LhStateEvent } from "@pi-unipi/core";
import { Gate } from "../gate.js";
import { OwnerCoordinator } from "../owner.js";
import { lhStateFrom } from "../lh-state.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { LhMode } from "../modes.js";

function wiredHarness(defaultMode: LhMode = "none", dir = mkdtempSync(join(tmpdir(), "lh-state-"))) {
  let ready = false;
  const owner = new OwnerCoordinator({
    statePath: () => join(dir, "state.json"),
    onChange: (_snapshot, event) => {
      gate.onOwnerChanged(event);
      publishLh();
    },
  });
  // Mirrors index.ts's publishLh (the single LH_STATE publish point).
  const publishLh = (): void => {
    if (!ready) return;
    bus.emit(UNIPI_EVENTS.LH_STATE, lhStateFrom(owner.getActive(), owner.getParked(), owner.lastStop(), gate.displayMode()));
  };
  const gate = new Gate({
    owner,
    loadSettings: () => ({ ...DEFAULT_SETTINGS, defaultMode }),
    env: {},
    onDisplayChanged: publishLh,
  });
  ready = true;
  return {
    owner,
    gate,
    publishLh,
    dir,
    state: (): LhStateEvent | undefined => bus.get(UNIPI_EVENTS.LH_STATE),
  };
}

beforeEach(() => resetBusForTests());

test("active goal owner → mode goal, owner active", () => {
  const h = wiredHarness();
  h.owner.activate("goal", "objective");
  assert.deepEqual(h.state(), {
    mode: "goal",
    owner: { kind: "goal", status: "active" },
  });
});

test("UNI-122: finish between turns → mode falls back to default, lastStop complete immediately", () => {
  const h = wiredHarness("none");
  h.owner.activate("goal", "objective");
  // Owner settles; NO turn runs afterwards (no before_agent_start).
  h.owner.finish("complete(verifier_met)");
  const state = h.state();
  assert.equal(state?.mode, "none", "footer must flip at settlement, not the next turn");
  assert.equal(state?.owner, undefined);
  assert.equal(state?.lastStop?.kind, "complete");
  assert.equal(typeof state?.lastStop?.at, "number");
});

test("suspend → mode none, paused goal, parked owner, lastStop paused", () => {
  const h = wiredHarness("none");
  h.owner.activate("goal", "objective");
  h.owner.suspend("paused(verifier_inconclusive)");
  const state = h.state();
  assert.equal(state?.mode, "none");
  assert.equal(state?.paused, "goal");
  assert.deepEqual(state?.owner, { kind: "goal", status: "parked" });
  assert.equal(state?.lastStop?.kind, "paused");
});

test("setSessionMode('none') without an owner → display mode none", () => {
  const h = wiredHarness("none");
  h.gate.setSessionMode("none");
  assert.equal(h.state()?.mode, "none");
  assert.equal(h.gate.displayMode(), "none");
});

test("session_start with a persisted parked owner → paused goal (not a plain default)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-state-"));
  // Previous session parks a goal and shuts down (same state file!).
  const previous = wiredHarness("none", dir);
  previous.owner.activate("goal", "objective");
  previous.owner.suspend("paused(user_requested)");
  resetBusForTests();
  // New session on the same state file: index wires resetDisplay BEFORE
  // owner.restore(), whose onChange publishes.
  {
    let ready = false;
    const owner = new OwnerCoordinator({
      statePath: () => join(dir, "state.json"),
      onChange: (_snapshot, event) => {
        gate.onOwnerChanged(event);
        publishLh();
      },
    });
    const publishLh = (): void => {
      if (!ready) return;
      bus.emit(UNIPI_EVENTS.LH_STATE, lhStateFrom(owner.getActive(), owner.getParked(), owner.lastStop(), gate.displayMode()));
    };
    const gate = new Gate({
      owner,
      loadSettings: () => ({ ...DEFAULT_SETTINGS, defaultMode: "none" }),
      env: {},
      onDisplayChanged: publishLh,
    });
    ready = true;

    gate.resetDisplay("none"); // session_start, before restore
    assert.equal(gate.displayMode(), "none", "no owner yet → settings default");
    owner.restore();
    const state = bus.get(UNIPI_EVENTS.LH_STATE);
    assert.equal(state?.paused, "goal", "restored parked owner surfaces as paused");
    assert.deepEqual(state?.owner, { kind: "goal", status: "parked" });
    assert.equal(state?.mode, "none", "no ACTIVE owner → display mode stays the default");
    assert.equal(state?.lastStop, undefined, "restore records no stop this run");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("lhStateFrom: parked-only snapshot keeps the display mode visible", () => {
  const parked = {
    ownerId: "o1",
    kind: "goal",
    label: "obj",
    status: "parked",
    revision: 0,
    lease: { ownerId: "o1", generation: 1 },
    updatedAt: "t",
  } as const;
  const state = lhStateFrom(undefined, parked, { kind: "paused", at: 5 }, "none");
  assert.deepEqual(state, {
    mode: "none",
    paused: "goal",
    owner: { kind: "goal", status: "parked" },
    lastStop: { kind: "paused", at: 5 },
  });
});
