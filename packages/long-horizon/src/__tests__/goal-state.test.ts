import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GoalMachine,
  digestObjective,
  isConditionWithinLimit,
  DEFAULT_MAX_TURNS,
  DEFAULT_STALL_CAP,
} from "../engine/goal-state.js";

function machine(): { m: GoalMachine; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lh-goal-"));
  const path = join(dir, "goal.json");
  return { m: new GoalMachine({ statePath: () => path }), dir, path };
}

function create() {
  const { m, dir } = machine();
  const result = m.create("all tests in packages/runtime pass");
  assert.equal(result.kind, "created");
  return { m, goal: result.kind === "created" ? result.goal : undefined, dir };
}

test("create sets defaults, digest, and baseline-pending budget", () => {
  const { m, goal, dir } = create();
  assert.ok(goal);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.maxTurns, DEFAULT_MAX_TURNS);
  assert.equal(goal?.stallCap, DEFAULT_STALL_CAP);
  assert.equal(goal?.tokenBudget, null);
  assert.equal(goal?.tokensBaselinePending, true);
  assert.equal(goal?.objectiveDigest, digestObjective("all tests in packages/runtime pass"));
  assert.equal(goal?.lease.generation, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("one goal: create refuses while unfinished, replaces when terminal", () => {
  const { m, dir } = create();
  const second = m.create("another objective");
  assert.equal(second.kind, "unfinished");
  // User-requested completion is terminal without a verifier.
  m.clear();
  const third = m.create("fresh objective");
  assert.equal(third.kind, "created");
  rmSync(dir, { recursive: true, force: true });
});

test("condition limit enforced (codeUnits and utf8 bytes)", () => {
  assert.equal(isConditionWithinLimit("short"), true);
  assert.equal(isConditionWithinLimit("x".repeat(501)), false); // codeUnits
  assert.equal(isConditionWithinLimit("😀".repeat(500)), false); // bytes only: 500 chars, 2000 bytes
  const { m } = machine();
  assert.throws(() => m.create("x".repeat(501)), RangeError);
});

test("settlement: CAS — stale revision silently ignored", () => {
  const { m, goal, dir } = create();
  const settled = m.settleTurn({ goalId: goal!.goalId, revision: 0, tokensNow: 1000 });
  assert.ok(settled);
  const stale = m.settleTurn({ goalId: goal!.goalId, revision: 0, tokensNow: 2000 });
  assert.equal(stale, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("baseline-pending: first tokensNow writes the baseline, budget bounds only growth", () => {
  const { m: mm, dir } = machine();
  mm.create("objective", { tokenBudget: 5_000 });
  const g1 = mm.getActive()!;
  // First settlement: baseline = 10_000. Spend 4_999 below budget.
  let state = mm.settleTurn({ goalId: g1.goalId, revision: g1.revision, tokensNow: 10_000 })!;
  assert.equal(state.tokensAtStart, 10_000);
  assert.equal(state.status, "active");
  // Cross the budget: 16_000 - 10_000 >= 5_000 → budget_limited(token).
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, tokensNow: 16_000 })!;
  assert.equal(state.status, "budget_limited");
  assert.equal(state.reason, "budget_limited(token)");
  rmSync(dir, { recursive: true, force: true });
});

test("turn cap → budget_limited(max_turns)", () => {
  const { m: mm, dir } = machine();
  mm.create("objective", { maxTurns: 3 });
  let state = mm.getActive()!;
  for (let i = 0; i < 2; i++) {
    state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: true })!;
  }
  assert.equal(state.status, "active");
  assert.equal(state.turn, 2);
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: true })!;
  assert.equal(state.status, "budget_limited");
  assert.equal(state.reason, "budget_limited(max_turns)");
  rmSync(dir, { recursive: true, force: true });
});

test("stall: false increments, true resets, undefined is neutral", () => {
  const { m: mm, dir } = machine();
  mm.create("objective", { stallCap: 3 });
  let state = mm.getActive()!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: false })!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision })!; // neutral
  assert.equal(state.noProgressStreak, 1);
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: true })!;
  assert.equal(state.noProgressStreak, 0);
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: false })!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: false })!;
  assert.equal(state.status, "active"); // 2/3 — not yet
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, madeProgress: false })!;
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "paused(no_progress)");
  rmSync(dir, { recursive: true, force: true });
});

test("propose+verify: worker claim + verifier met completes; not_met feeds notMetStreak", () => {
  const { m: mm, dir } = machine();
  mm.create("objective");
  let state = mm.getActive()!;
  state = mm.settleTurn({
    goalId: state.goalId,
    revision: state.revision,
    completionClaim: { summary: "tests pass" },
    verifier: { verdict: "met" },
  })!;
  assert.equal(state.status, "complete");
  assert.equal(state.reason, "complete(verifier_met)");
  rmSync(dir, { recursive: true, force: true });

  // Rejected claim path.
  const second = machine();
  second.m.create("objective");
  let s2 = second.m.getActive()!;
  s2 = second.m.settleTurn({
    goalId: s2.goalId,
    revision: s2.revision,
    completionClaim: { summary: "done" },
    verifier: { verdict: "not_met", missing: ["test suite green"] },
  })!;
  assert.equal(s2.status, "active"); // not complete
  assert.equal(s2.notMetStreak, 1);
  rmSync(second.dir, { recursive: true, force: true });
});

test("worker claim without verifier never completes", () => {
  const { m: mm, dir } = machine();
  mm.create("objective");
  let state = mm.getActive()!;
  state = mm.settleTurn({
    goalId: state.goalId,
    revision: state.revision,
    completionClaim: { summary: "trust me" },
  })!;
  assert.equal(state.status, "active"); // proposal alone is not completion
  rmSync(dir, { recursive: true, force: true });
});

test("verifier impossible → blocked(verifier_impossible)", () => {
  const { m: mm, dir } = machine();
  mm.create("objective");
  let state = mm.getActive()!;
  state = mm.settleTurn({
    goalId: state.goalId,
    revision: state.revision,
    completionClaim: {},
    verifier: { verdict: "impossible" },
  })!;
  assert.equal(state.status, "blocked");
  assert.equal(state.reason, "blocked(verifier_impossible)");
  rmSync(dir, { recursive: true, force: true });
});

test("blocked needs 3 consecutive proposals; safety refusal is immediate", () => {
  const { m: mm, dir } = machine();
  mm.create("objective");
  let state = mm.getActive()!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, blockedProposal: true })!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, blockedProposal: true })!;
  assert.equal(state.status, "active"); // 2 of 3
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, blockedProposal: true })!;
  assert.equal(state.status, "blocked");
  assert.equal(state.reason, "blocked(threshold_3turns)");

  const other = machine();
  other.m.create("objective");
  let s2 = other.m.getActive()!;
  s2 = other.m.settleTurn({ goalId: s2.goalId, revision: s2.revision, safetyRefusal: true })!;
  assert.equal(s2.status, "blocked");
  assert.equal(s2.reason, "blocked(safety_policy)");
  rmSync(dir, { recursive: true, force: true });
  rmSync(other.dir, { recursive: true, force: true });
});

test("waiting is non-terminal; wake returns to active", () => {
  const { m: mm, dir } = machine();
  mm.create("objective");
  let state = mm.getActive()!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, waiting: true })!;
  assert.equal(state.status, "waiting");
  assert.equal(state.reason, "waiting(external_event)");
  const woken = mm.wakeWaiting();
  assert.equal(woken?.status, "active");
  rmSync(dir, { recursive: true, force: true });
});

test("pause/resume renew the lease and reset the blocked audit", () => {
  const { m: mm, dir } = machine();
  mm.create("objective");
  let state = mm.getActive()!;
  state = mm.settleTurn({ goalId: state.goalId, revision: state.revision, blockedProposal: true })!;
  const paused = mm.pause("paused(superseded)")!;
  assert.equal(paused.lease.generation, 1);
  const resumed = mm.resume()!;
  assert.equal(resumed.lease.generation, 2);
  assert.equal(resumed.blockedProposalStreak, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("crash recovery: restore reloads durable state", () => {
  const { m: mm, path, dir } = machine();
  mm.create("objective");
  mm.pause("paused(superseded)");
  const revived = new GoalMachine({ statePath: () => path });
  const restored = revived.restore();
  assert.equal(restored?.status, "paused");
  assert.equal(restored?.reason, "paused(superseded)");
  rmSync(dir, { recursive: true, force: true });
});

test("no_progress_after_completion_claim: rejected claims + stall park", () => {
  const { m: mm, dir } = machine();
  mm.create("objective", { stallCap: 3, maxTurns: 50 });
  let state = mm.getActive()!;
  // Three rejected claims in a row with no progress between them.
  for (let i = 0; i < 2; i++) {
    state = mm.settleTurn({
      goalId: state.goalId,
      revision: state.revision,
      completionClaim: { summary: "done" },
      verifier: { verdict: "not_met", missing: ["x"] },
      madeProgress: false,
    })!;
  }
  assert.equal(state.status, "active"); // streak 2/3, notMet 2/3
  state = mm.settleTurn({
    goalId: state.goalId,
    revision: state.revision,
    completionClaim: { summary: "done again" },
    verifier: { verdict: "not_met", missing: ["x"] },
    madeProgress: false,
  })!;
  assert.equal(state.status, "paused");
  assert.equal(state.reason, "paused(no_progress_after_completion_claim)");
  rmSync(dir, { recursive: true, force: true });
});
