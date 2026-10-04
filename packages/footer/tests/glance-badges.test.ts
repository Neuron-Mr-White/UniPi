/**
 * @pi-unipi/footer — Frame badge tests
 *
 * planFrameBadges degradation order (kanboard → fusion → plan/permission →
 * mode), the badge toggles in composeGlanceTitles, and the rainbow gates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planFrameBadges, composeGlanceTitles, composeTopParts, composeBottomCluster, measureFrameLines } from "../src/glance-editor.js";
import type { GlanceStatus } from "../src/glance-editor.js";
import type { BadgeToggles } from "../src/types.js";
import { setIconStyle } from "../src/rendering/icons.js";

const ALL_ON: BadgeToggles = { mode: true, planPermission: true, fusion: true, kanboard: true };

function status(overrides: Partial<GlanceStatus> = {}): GlanceStatus {
  return {
    workspace: "unipi",
    lhMode: "Goal Mode",
    planMode: true,
    permissionMode: "ask",
    branch: "v3",
    contextPct: 42,
    contextWindow: 1_000_000,
    modelName: "Opus 4.5",
    thinkingLevel: "high",
    fusion: { leadName: "lead", leadEffort: "high", sidekickName: "side", sidekickEffort: "mid" },
    kanboard: { claims: ["TASK-1"], autowork: false },
    rainbow: "always",
    badges: { ...ALL_ON },
    ...overrides,
  };
}

test("planFrameBadges keeps every badge when everything fits", () => {
  const plan = planFrameBadges(ALL_ON, () => true);
  assert.deepEqual(plan, ALL_ON);
});

test("drops kanboard first", () => {
  // Full plan measures 150; the line only fits 140, so exactly one drop.
  const width = 140;
  const plan = planFrameBadges(ALL_ON, (p) => measureSynthetic(p) <= width);
  assert.equal(plan.kanboard, false);
  for (const key of ["fusion", "planPermission", "mode"] as const) {
    assert.equal(plan[key], true, `${key} must survive the first drop`);
  }
});

test("drop order is kanboard → fusion → planPermission → mode", () => {
  const seen: string[] = [];
  const widthsByPlan: Record<string, number> = {
    "1111": 300,
    "0111": 240,
    "0011": 200,
    "0001": 150,
    "0000": 80,
  };
  const plan = planFrameBadges(ALL_ON, (p) => {
    const key = `${p.kanboard ? 1 : 0}${p.fusion ? 1 : 0}${p.planPermission ? 1 : 0}${p.mode ? 1 : 0}`;
    seen.push(key);
    return widthsByPlan[key] <= 160;
  });
  // 1111 too wide → drop kanboard (0111=240 too wide) → drop fusion (0011=200
  // too wide) → drop planPermission (0001=150 fits).
  assert.equal(seen[0], "1111");
  assert.equal(seen[1], "0111");
  assert.equal(seen[2], "0011");
  assert.equal(seen[3], "0001");
  assert.deepEqual(plan, { mode: true, planPermission: false, fusion: false, kanboard: false });
});

test("mode is only dropped after all other badges are already off", () => {
  const dropped: string[] = [];
  const plan = planFrameBadges(ALL_ON, (p) => {
    // Fits only when every badge still on has already been dropped — the
    // loop must walk the full order and take mode last.
    const on = (['kanboard', 'fusion', 'planPermission', 'mode'] as const).filter(k => p[k]);
    if (on.length === 0) return true;
    dropped.push(on[0]!); // the next badge the loop will drop
    return false;
  });
  assert.deepEqual(dropped, ["kanboard", "fusion", "planPermission", "mode"]);
  for (const key of ["kanboard", "fusion", "planPermission", "mode"] as const) {
    assert.equal(plan[key], false);
  }
});

test("never drops below the user's own toggles", () => {
  const enabled: BadgeToggles = { mode: true, planPermission: false, fusion: true, kanboard: true };
  const plan = planFrameBadges(enabled, () => false);
  assert.equal(plan.planPermission, false);
  for (const key of ["kanboard", "fusion", "mode"] as const) {
    assert.equal(plan[key], false);
  }
});

/** Synthetic width model: each badge contributes a fixed cost. */
function measureSynthetic(p: BadgeToggles): number {
  return (p.kanboard ? 60 : 0) + (p.fusion ? 40 : 0) + (p.planPermission ? 30 : 0) + (p.mode ? 20 : 0);
}

test("badge toggles hide their title parts", () => {
  setIconStyle("text");
  const on = composeGlanceTitles("UNIPI", "v3", "unipi", "Goal Mode", { claims: ["TASK-1"], autowork: false });
  assert.ok(on.titleParts.some(p => p.startsWith("mode:")));
  assert.ok(on.titleParts.some(p => p.startsWith("kanboard:")));

  const off = composeGlanceTitles("UNIPI", "v3", "unipi", "Goal Mode", { claims: ["TASK-1"], autowork: false }, { mode: false, kanboard: false });
  assert.ok(!off.titleParts.some(p => p.startsWith("mode:")));
  assert.ok(!off.titleParts.some(p => p.startsWith("kanboard:")));
  assert.ok(off.titleParts.some(p => p.startsWith("branch:")));
  setIconStyle(undefined);
});

test("planPermission badge gates the top-right cluster", () => {
  const st = status();
  assert.ok(composeTopParts(st, ALL_ON).cluster.includes("PLAN"));
  assert.equal(composeTopParts(st, { ...ALL_ON, planPermission: false }).cluster, "");
});

test("fusion badge gates the bottom cluster (model shown instead)", () => {
  const st = status();
  assert.ok(composeBottomCluster(st, ALL_ON).includes("Fusion"));
  const without = composeBottomCluster(st, { ...ALL_ON, fusion: false });
  assert.ok(without.includes(st.modelName));
  assert.ok(!without.includes("Fusion"));
});

test("measureFrameLines shrinks when badges drop", () => {
  const st = status();
  const full = measureFrameLines(st, ALL_ON);
  const bare = measureFrameLines(st, { mode: false, planPermission: false, fusion: false, kanboard: false });
  assert.ok(bare.top < full.top);
  assert.ok(bare.bottom < full.bottom);
});
