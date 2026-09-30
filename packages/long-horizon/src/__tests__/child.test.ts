import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getSharedOwnerStatus } from "@pi-unipi/core";
import { Gate } from "../gate.js";
import { OwnerCoordinator, CHILD_OWNER_REFUSAL, stopKindOf } from "../owner.js";
import { DEFAULT_SETTINGS } from "../settings.js";

const CHILD_KEYS = ["UNIPI_FUSION_CHILD", "UNIPI_SUBAGENT_CHILD", "UNIPI_KANBOARD_CHILD", "UNIPI_LH_ALLOW_CHILD"] as const;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = CHILD_KEYS.map((key) => process.env[key]);
  for (const key of CHILD_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of CHILD_KEYS) delete process.env[key];
    CHILD_KEYS.forEach((key, index) => {
      const previous = saved[index];
      if (previous !== undefined) process.env[key] = previous;
    });
  }
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "lh-child-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "state.json") });
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  return { gate, owner, dir };
}

// ── gate: children never resolve an LH mode ─────────────────────────────

test("child process: every turn resolves none/child, judge skipped", async () => {
  await withEnv({ UNIPI_SUBAGENT_CHILD: "1" }, async () => {
    const { gate } = harness();
    const state = await gate.resolveForTurn("keep going until tests pass");
    assert.deepEqual(state, { mode: "none", source: "child" });
  });
});

test("child process: even an explicit mode command resolves none/child", async () => {
  await withEnv({ UNIPI_FUSION_CHILD: "1" }, async () => {
    const { gate } = harness();
    gate.setExplicit("goal");
    const state = await gate.resolveForTurn("/unipi:goal do it");
    assert.deepEqual(state, { mode: "none", source: "child" });
  });
});

test("UNIPI_LH_ALLOW_CHILD=1 restores normal resolution in a child", async () => {
  await withEnv({ UNIPI_SUBAGENT_CHILD: "1", UNIPI_LH_ALLOW_CHILD: "1" }, async () => {
    const { gate } = harness();
    gate.setExplicit("goal");
    const state = await gate.resolveForTurn("objective");
    assert.equal(state.mode, "goal");
    assert.equal(state.source, "explicit");
  });
});

test("the lead is unaffected: no child env, normal resolution", async () => {
  await withEnv({}, async () => {
    const { gate } = harness();
    gate.setExplicit("goal");
    const state = await gate.resolveForTurn("objective");
    assert.equal(state.mode, "goal");
  });
});

// ── owner: children cannot own ───────────────────────────────────────────

test("child process: activate throws the child refusal", async () => {
  await withEnv({ UNIPI_SUBAGENT_CHILD: "1" }, async () => {
    const { owner } = harness();
    assert.throws(() => owner.activate("goal", "objective"), /Long-horizon owners are not available inside a child agent/);
    assert.equal(owner.getActive(), undefined);
  });
});

test("child process: the refusal carries the report-back instruction", async () => {
  await withEnv({ UNIPI_FUSION_CHILD: "1" }, async () => {
    const { owner } = harness();
    let message = "";
    try {
      owner.activate("ralph-loop", "loop");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.equal(message, CHILD_OWNER_REFUSAL);
    assert.match(message, /report back to the lead/);
  });
});

test("UNIPI_LH_ALLOW_CHILD=1 allows owning in a child", async () => {
  await withEnv({ UNIPI_SUBAGENT_CHILD: "1", UNIPI_LH_ALLOW_CHILD: "1" }, async () => {
    const { owner } = harness();
    assert.ok(owner.activate("goal", "objective"));
  });
});

// ── owner status holder: transitions publish ────────────────────────────

test("owner transitions publish to the shared holder", async () => {
  await withEnv({}, () => {
    const { owner } = harness();
    const active = owner.activate("goal", "objective");
    assert.ok(active);
    assert.deepEqual(getSharedOwnerStatus()?.owner, { kind: "goal", status: "active" });
    const parked = owner.suspend("paused(user_requested)");
    assert.ok(parked);
    assert.deepEqual(getSharedOwnerStatus()?.owner, { kind: "goal", status: "parked" });
    owner.resume();
    assert.deepEqual(getSharedOwnerStatus()?.owner, { kind: "goal", status: "active" });
    owner.finish("complete(verifier_met)");
    assert.equal(getSharedOwnerStatus()?.owner, undefined);
    assert.equal(getSharedOwnerStatus()?.lastStop?.kind, "complete");
  });
});

test("stop kinds map: complete/paused/budget/other", () => {
  assert.equal(stopKindOf("complete(verifier_met)"), "complete");
  assert.equal(stopKindOf("complete"), "complete");
  assert.equal(stopKindOf("paused(user_requested)"), "paused");
  assert.equal(stopKindOf("budget_limited"), "budget");
  assert.equal(stopKindOf("stalled"), "other");
  assert.equal(stopKindOf("failed"), "other");
});

test("finish records the mapped stop kind on the shared holder", async () => {
  await withEnv({}, () => {
    const { owner } = harness();
    owner.activate("goal", "objective");
    owner.finish("budget_limited");
    assert.equal(getSharedOwnerStatus()?.lastStop?.kind, "budget");
    assert.equal(typeof getSharedOwnerStatus()?.lastStop?.at, "number");
  });
});
