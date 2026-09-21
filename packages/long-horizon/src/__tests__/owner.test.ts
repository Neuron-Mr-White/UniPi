import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OwnerCoordinator, type OwnerEvent } from "../owner.js";

interface Harness {
  coordinator: OwnerCoordinator;
  events: OwnerEvent[];
  dir: string;
  statePath: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lh-owner-"));
  const statePath = join(dir, "state.json");
  const events: OwnerEvent[] = [];
  const coordinator = new OwnerCoordinator({
    statePath: () => statePath,
    onChange: (_snapshot, event) => events.push(event),
  });
  return { coordinator, events, dir, statePath };
}

test("activate creates the single active owner with lease generation 0", () => {
  const { coordinator, events } = harness();
  const owner = coordinator.activate("goal", "all tests pass");
  assert.ok(owner);
  assert.equal(owner?.status, "active");
  assert.equal(owner?.lease.generation, 0);
  assert.equal(owner?.revision, 0);
  assert.equal(events.at(-1)?.type, "activated");
  assert.equal(coordinator.snapshot().active?.ownerId, owner?.ownerId);
});

test("one automation owner: activate refuses while another is active", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "first");
  assert.equal(coordinator.activate("swarm", "second"), undefined);
  assert.equal(coordinator.snapshot().active?.kind, "goal");
});

test("suspend parks the active owner and bumps its lease generation", () => {
  const { coordinator } = harness();
  const goal = coordinator.activate("goal", "migrate to ESM");
  const leaseBefore = goal?.lease.generation ?? 0;
  const suspended = coordinator.suspend("paused(superseded_by:swarm)");
  assert.ok(suspended);
  assert.equal(suspended?.status, "parked");
  assert.equal(suspended?.reason, "paused(superseded_by:swarm)");
  assert.equal(suspended?.lease.generation, leaseBefore + 1);
  assert.equal(coordinator.getActive(), undefined);
  assert.equal(coordinator.getParked()?.ownerId, goal?.ownerId);
});

test("max one parked owner: suspend refuses when the park slot is held", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "goal");
  coordinator.suspend("paused(superseded_by:swarm)");
  coordinator.activate("swarm", "swarm");
  // Park slot still holds the goal — suspending the swarm must refuse.
  assert.equal(coordinator.suspend("paused(superseded_by:graph)"), undefined);
  assert.equal(coordinator.getActive()?.kind, "swarm");
  assert.equal(coordinator.getParked()?.kind, "goal");
});

test("resume reactivates the parked owner and renews the lease again", () => {
  const { coordinator } = harness();
  const goal = coordinator.activate("goal", "g");
  coordinator.suspend("paused(superseded_by:swarm)");
  coordinator.activate("swarm", "s");
  coordinator.finish("settled");
  const resumed = coordinator.resume();
  assert.ok(resumed);
  assert.equal(resumed?.ownerId, goal?.ownerId);
  assert.equal(resumed?.status, "active");
  assert.equal(resumed?.lease.generation, 2);
  assert.equal(coordinator.getParked(), undefined);
});

test("resume refuses while another owner is active", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "g");
  coordinator.suspend("paused(x)");
  coordinator.activate("swarm", "s");
  assert.equal(coordinator.resume(), undefined);
  assert.equal(coordinator.getActive()?.kind, "swarm");
  assert.equal(coordinator.getParked()?.kind, "goal");
});

test("stale lease from a pre-suspend turn is rejected", () => {
  const { coordinator } = harness();
  const goal = coordinator.activate("goal", "g");
  const staleLease = goal?.lease;
  coordinator.suspend("paused(superseded_by:swarm)");
  coordinator.finish("cleared");
  coordinator.resume();
  if (!staleLease || !goal) throw new Error("unreachable");
  // The resumed owner has generation 2; the captured lease says 0.
  assert.equal(coordinator.matchesActiveLease(goal.ownerId, staleLease), false);
});

test("finish appends bounded history and frees the active slot", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "g");
  coordinator.finish("complete(verifier_met)");
  assert.equal(coordinator.getActive(), undefined);
  assert.equal(coordinator.snapshot().history.length, 1);
  assert.equal(coordinator.snapshot().history[0]?.terminalReason, "complete(verifier_met)");
  for (let i = 0; i < 15; i++) {
    coordinator.activate("ralph-loop", `loop-${i}`);
    coordinator.finish("max_iterations");
  }
  assert.equal(coordinator.snapshot().history.length, 10);
});

test("advanceRevision bumps revision and persists", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "g");
  const advanced = coordinator.advanceRevision();
  assert.equal(advanced?.revision, 1);
  assert.equal(coordinator.getActive()?.revision, 1);
});

test("state survives restart: restore is crash recovery", () => {
  const { coordinator, dir, statePath } = harness();
  const goal = coordinator.activate("goal", "g");
  coordinator.suspend("paused(superseded_by:swarm)");
  coordinator.activate("swarm", "s");
  coordinator.advanceRevision();

  const events2: OwnerEvent[] = [];
  const revived = new OwnerCoordinator({
    statePath: () => statePath,
    onChange: (_s, e) => events2.push(e),
  });
  const snapshot = revived.restore();
  assert.equal(snapshot.active?.kind, "swarm");
  assert.equal(snapshot.active?.revision, 1);
  assert.equal(snapshot.parked?.ownerId, goal?.ownerId);
  assert.equal(events2.at(-1)?.type, "restored");
  // And the revived coordinator refuses a second activate — the owner holds.
  assert.equal(revived.activate("goal", "other"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("clearParked frees the park slot", () => {
  const { coordinator } = harness();
  coordinator.activate("goal", "g");
  coordinator.suspend("paused(x)");
  const cleared = coordinator.clearParked();
  assert.ok(cleared);
  assert.equal(coordinator.getParked(), undefined);
  assert.equal(coordinator.clearParked(), undefined);
});

test("corrupt state file restores as empty rather than resurrecting garbage", () => {
  const { coordinator, dir, statePath } = harness();
  const { writeFileSync: wf } = { writeFileSync };
  wf(statePath, "{not json");
  const snapshot = coordinator.restore();
  assert.equal(snapshot.active, undefined);
  assert.equal(snapshot.parked, undefined);
  rmSync(dir, { recursive: true, force: true });
});
