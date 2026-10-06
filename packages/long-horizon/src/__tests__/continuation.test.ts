import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoalMachine } from "../engine/goal-state.js";
import { GoalToolset } from "../tools/goal.js";
import { OwnerCoordinator } from "../owner.js";
import {
  GoalContinuation,
  selectHint,
  waitBackoffMs,
  WAIT_BACKOFF_MAX_MS,
  type TurnActivity,
} from "../engine/continuation.js";
import {
  CONTINUATION_HINT,
  NO_PROGRESS_NUDGE,
  NO_TOOL_NUDGE,
  TERMINAL_AUDIT,
  WRAP_UP_PROMPT,
  escapeXmlText,
  renderContinuationHint,
  renderKickoff,
} from "../prompts/goal.js";

const activity = (over: Partial<TurnActivity> = {}): TurnActivity => ({
  toolCalls: 3,
  changedFiles: ["src/a.ts"],
  commands: ["npm test"],
  recentTail: [{ role: "assistant", text: "tests green" }],
  ...over,
});

interface Rig {
  machine: GoalMachine;
  owner: OwnerCoordinator;
  toolset: GoalToolset;
  sent: string[];
  notifications: Array<{ text: string; level: string }>;
  timers: Array<{ delayMs: number; fire: () => void }>;
  continuation: GoalContinuation;
  dir: string;
  verifierResults: Array<{ verdict: string; reason: string; missing?: string[] }>;
}

function rig(
  verdicts: Array<{ verdict: string; reason: string; missing?: string[] }> = [],
  options: { boardLine?: () => string | null } = {},
): Rig {
  const dir = mkdtempSync(join(tmpdir(), "lh-cont-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const sent: string[] = [];
  const notifications: Array<{ text: string; level: string }> = [];
  const timers: Array<{ delayMs: number; fire: () => void }> = [];
  let call = 0;
  const verifierResults = verdicts;
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: {
      evaluate: async () => {
        const result = verifierResults[call] ?? verifierResults[verifierResults.length - 1];
        call += 1;
        return JSON.stringify(result);
      },
    },
    send: (message) => sent.push(message),
    notify: (text, level) => notifications.push({ text, level: level ?? "warning" }),
    schedule: (fire, delayMs) => timers.push({ delayMs, fire }),
    ...(options.boardLine ? { boardLine: options.boardLine } : {}),
  });
  return { machine, owner, toolset, sent, notifications, timers, continuation, dir, verifierResults };
}

async function startGoal(r: Rig, options: { maxTurns?: number; tokenBudget?: number } = {}) {
  r.machine.create("all tests pass", {
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
  });
  r.owner.activate("goal", "all tests pass");
  // First turn end delivers the kickoff contract.
  const kickoff = await r.continuation.onTurnEnd(activity());
  assert.deepEqual(kickoff, { action: "none", reason: "kickoff-delivered" });
  assert.match(r.sent[0] ?? "", /Continue working toward the active thread goal/);
  return r.machine.getActive()!;
}

// ── prompts ──────────────────────────────────────────────────────────────

test("kickoff escapes the objective XML-style and is deterministic", () => {
  const a = renderKickoff('make <b>&work</b> "safe"');
  const b = renderKickoff('make <b>&work</b> "safe"');
  assert.equal(a, b);
  assert.ok(a.includes("&lt;b&gt;&amp;work&lt;/b&gt;"));
  assert.ok(!a.includes("<b>&work</b>"));
  assert.match(a, /user-provided data/);
  assert.match(a, /three consecutive goal turns/);
});

test("escapeXmlText covers the three dangerous chars", () => {
  assert.equal(escapeXmlText("a<b>&c</b>"), "a&lt;b&gt;&amp;c&lt;/b&gt;");
});

test("hint renders the status line without system-prompt coupling", () => {
  const machine = new GoalMachine({ statePath: () => "/dev/null" });
  machine.create("objective", { tokenBudget: 1000 });
  const goal = machine.getActive()!;
  const hint = renderContinuationHint(goal);
  assert.ok(hint.startsWith(CONTINUATION_HINT.slice(0, 30)));
  assert.match(hint, /turn 0\/50\)/);
});

// ── hint selection ───────────────────────────────────────────────────────

test("selectHint ordering: recovery > no-tool > no-progress > audit > hint", () => {
  const base = {
    toolCalls: 3,
    changedFiles: [],
    commands: [],
    recentTail: [],
  };
  const goal = {
    noProgressStreak: 2,
    stallCap: 8,
    turn: 5,
    maxTurns: 50,
  } as never;
  assert.equal(selectHint(goal, { ...base, toolCalls: 0 }, false), "nudge-no-tool");
  assert.equal(selectHint(goal, base, true), "recovery");
  assert.equal(selectHint(goal, base, false), "nudge-no-progress");
  const even = { ...goal, turn: 4, noProgressStreak: 0 } as never;
  assert.equal(selectHint(even, base, false), "hint");
  const audit = { ...goal, turn: 5, noProgressStreak: 0 } as never;
  assert.equal(selectHint(audit, base, false), "terminal-audit");
});

test("waitBackoffMs: 5s base, doubling, 5min cap", () => {
  assert.equal(waitBackoffMs(1), 5_000);
  assert.equal(waitBackoffMs(2), 10_000);
  assert.equal(waitBackoffMs(3), 20_000);
  assert.equal(waitBackoffMs(20), WAIT_BACKOFF_MAX_MS);
});

// ── turn-end flows ───────────────────────────────────────────────────────

test("plain continue: one-line hint after kickoff", async () => {
  const r = rig();
  await startGoal(r);
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "continue");
  assert.equal(decision.via, "hint");
  assert.match(r.sent[1] ?? "", /Continue working toward the active thread goal from the current/);
  assert.match(r.sent[1] ?? "", /turn 1\/50/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("verified completion claim stops the goal and finishes the owner", async () => {
  const r = rig([{ verdict: "met", reason: "suite green on rerun" }]);
  await startGoal(r);
  const goal = r.machine.getActive()!;
  (r.toolset as unknown as { pending: unknown }).pending = {
    kind: "completion",
    goalId: goal.goalId,
    revision: goal.revision,
    summary: "tests pass",
    proposedAt: new Date().toISOString(),
  };
  const decision = await r.continuation.onTurnEnd(activity());
  assert.deepEqual(decision, { action: "stopped", terminal: "complete(verifier_met)", wrapUp: false });
  assert.equal(r.machine.get()?.status, "complete");
  assert.equal(r.owner.getActive(), undefined); // owner finished
  assert.equal(r.sent.length, 1); // kickoff only — clean completion is quiet
  rmSync(r.dir, { recursive: true, force: true });
});

test("rejected claim feeds missing[] back into the next hint", async () => {
  const r = rig([{ verdict: "not_met", reason: "lint not verified", missing: ["lint clean"] }]);
  await startGoal(r);
  const goal = r.machine.getActive()!;
  (r.toolset as unknown as { pending: unknown }).pending = {
    kind: "completion",
    goalId: goal.goalId,
    revision: goal.revision,
    summary: "done",
    proposedAt: new Date().toISOString(),
  };
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "continue");
  assert.match(r.sent[1] ?? "", /lint not verified \(missing: lint clean\)/);
  assert.equal(r.machine.get()?.status, "active");
  assert.equal(r.machine.get()?.notMetStreak, 1);
  rmSync(r.dir, { recursive: true, force: true });
});

function proposeCompletion(r: Rig, summary: string): void {
  const goal = r.machine.getActive()!;
  (r.toolset as unknown as { pending: unknown }).pending = {
    kind: "completion",
    goalId: goal.goalId,
    revision: goal.revision,
    summary,
    proposedAt: new Date().toISOString(),
  };
}

test("batch work + early claim keeps going until the unconditional not_met cap", async () => {
  const r = rig([{ verdict: "not_met", reason: "only part done", missing: ["next batch"] }]);
  await startGoal(r);
  for (let batch = 1; batch <= 4; batch += 1) {
    proposeCompletion(r, `batch ${batch} done`);
    const decision = await r.continuation.onTurnEnd(activity({ changedFiles: [`src/batch${batch}.ts`] }));
    assert.equal(decision.action, "continue", `batch ${batch}`);
    assert.equal((decision as { via: string }).via === "hint" || (decision as { via: string }).via === "terminal-audit", true);
    assert.equal(r.machine.get()?.status, "active");
  }
  // 5th consecutive rejection pauses unconditionally — even with files changing.
  proposeCompletion(r, "batch 5 done");
  const decision = await r.continuation.onTurnEnd(activity({ changedFiles: ["src/batch5.ts"] }));
  assert.equal(decision.action, "stopped");
  assert.equal(r.machine.get()?.status, "paused");
  assert.equal(r.machine.get()?.reason, "paused(no_progress_after_completion_claim)");
  assert.match(r.notifications.at(-1)?.text ?? "", /rejected 5 times/);
  assert.match(r.notifications.at(-1)?.text ?? "", /next batch/);
  rmSync(r.dir, { recursive: true, force: true });
});

test("re-claiming without changing anything still stalls", async () => {
  const r = rig([{ verdict: "not_met", reason: "nothing new", missing: ["x"] }]);
  await startGoal(r);
  let decision;
  for (let i = 0; i < 12; i += 1) {
    proposeCompletion(r, "done again");
    decision = await r.continuation.onTurnEnd(activity({ changedFiles: [] }));
    if (decision.action === "stopped") break;
  }
  assert.equal(decision?.action, "stopped");
  assert.equal(r.machine.get()?.status, "paused");
  rmSync(r.dir, { recursive: true, force: true });
});

test("waiting via turn signal schedules a backoff wake that continues the goal", async () => {
  const r = rig();
  await startGoal(r);
  const decision = await r.continuation.onTurnEnd(activity({ waiting: true }));
  assert.equal(decision.action, "wait");
  assert.equal((decision as { delayMs: number }).delayMs, 5_000);
  assert.equal(r.timers.length, 1);
  assert.equal(r.machine.get()?.status, "waiting");
  // Nothing sent while waiting.
  assert.equal(r.sent.length, 1);
  // Fire the timer: wake + hint.
  r.timers[0]?.fire();
  assert.equal(r.machine.get()?.status, "active");
  assert.match(r.sent.at(-1) ?? '', /turn 1\/50/);
  // Second wait doubles the backoff.
  const second = await r.continuation.onTurnEnd(activity({ waiting: true }));
  if (second.action === "wait") assert.equal(second.delayMs, 5_000); // consecutiveWaits reset by wake
  rmSync(r.dir, { recursive: true, force: true });
});

test("budget_limited delivers exactly one wrap-up turn", async () => {
  const r = rig();
  await startGoal(r, { tokenBudget: 1_000 });
  // Turn 1: baseline lands at 10_000 (baseline-pending). Turn 2: blows past it.
  let tokens = 10_000;
  const cont = r.continuation as unknown as { deps: { getTokenCount?: () => number } };
  cont.deps.getTokenCount = () => tokens;
  const first = await r.continuation.onTurnEnd(activity());
  assert.equal(first.action, "continue"); // baseline written, within budget
  tokens = 999_999;
  const decision = await r.continuation.onTurnEnd(activity());
  assert.deepEqual(decision, { action: "stopped", terminal: "budget_limited(token)", wrapUp: true });
  assert.equal(r.sent.filter((m) => m === WRAP_UP_PROMPT).length, 1);
  assert.equal(r.owner.getActive(), undefined);
  rmSync(r.dir, { recursive: true, force: true });
});

test("recovery fragment arms once after a crash marker", async () => {
  const r = rig();
  await startGoal(r);
  r.continuation.armRecovery();
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "continue");
  assert.equal(decision.via, "recovery");
  assert.match(r.sent[1] ?? "", /Goal recovery/);
  const next = await r.continuation.onTurnEnd(activity());
  assert.equal((next as { via?: string }).via, "hint"); // one-shot
  rmSync(r.dir, { recursive: true, force: true });
});

test("no-tool turn triggers the NO_TOOL nudge", async () => {
  const r = rig();
  await startGoal(r);
  const decision = await r.continuation.onTurnEnd(activity({ toolCalls: 0 }));
  assert.equal(decision.action, "continue");
  assert.equal(decision.via, "nudge-no-tool");
  assert.match(r.sent[1] ?? "", new RegExp(NO_TOOL_NUDGE.slice(0, 20)));
  rmSync(r.dir, { recursive: true, force: true });
});

test("scheduled terminal audit fires every 5 turns", async () => {
  const r = rig();
  await startGoal(r);
  let decision = await r.continuation.onTurnEnd(activity());
  let turn = 1;
  while (turn < 5) {
    decision = await r.continuation.onTurnEnd(activity());
    turn += 1;
  }
  assert.equal(decision.action, "continue");
  assert.equal((decision as { via: string }).via, "terminal-audit");
  assert.match(r.sent.at(-1) ?? "", new RegExp(TERMINAL_AUDIT.slice(0, 18)));
  rmSync(r.dir, { recursive: true, force: true });
});

// ── verifier resilience (FIX 2) ──────────────────────────────────────────

test("evaluator failure retries once, then pauses verifier_unavailable and parks the owner", async () => {
  // Two consecutive unparseable evaluator replies → both attempts fail.
  const r = rig([{}, {}] as never);
  await startGoal(r);
  proposeCompletion(r, "done");
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "stopped");
  assert.equal(r.machine.get()?.status, "paused");
  assert.equal(r.machine.get()?.reason, "paused(verifier_unavailable)");
  assert.match(r.notifications[0]?.text ?? "", /unavailable twice/);
  assert.equal(r.sent.length, 1, "kickoff only — no continuation follow-up after the pause");
  // The goal is parked and resumable (FIX 2e).
  assert.notEqual(r.owner.getParked(), undefined);
  assert.notEqual(r.machine.resume(), undefined);
  assert.notEqual(r.owner.resume(), undefined);
  assert.equal(r.machine.get()?.status, "active");
  rmSync(r.dir, { recursive: true, force: true });
});

test("a single evaluator failure retries and recovers inside the same settlement", async () => {
  const r = rig([{}, { verdict: "met", reason: "evidence ok" }] as never);
  await startGoal(r);
  proposeCompletion(r, "done");
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "stopped");
  assert.equal(r.machine.get()?.status, "complete");
  assert.equal(r.machine.get()?.reason, "complete(verifier_met)");
  rmSync(r.dir, { recursive: true, force: true });
});

test("two inconclusive verdicts pause with the verifier's reason", async () => {
  const r = rig([
    { verdict: "inconclusive", reason: "evidence too weak" },
    { verdict: "inconclusive", reason: "still too weak" },
  ]);
  await startGoal(r);
  proposeCompletion(r, "done");
  await r.continuation.onTurnEnd(activity());
  assert.equal(r.machine.get()?.status, "active");
  proposeCompletion(r, "done again");
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "stopped");
  assert.equal(r.machine.get()?.reason, "paused(verifier_inconclusive)");
  assert.match(r.notifications.at(-1)?.text ?? "", /inconclusive twice.*still too weak/s);
  assert.notEqual(r.owner.getParked(), undefined);
  rmSync(r.dir, { recursive: true, force: true });
});

test("a pending proposal never survives the kickoff turn (FIX 2d)", async () => {
  const r = rig();
  const goal = r.machine.create("instant claim").kind === "created" ? r.machine.getActive()! : null;
  assert.ok(goal);
  r.owner.activate("goal", goal.objective);
  (r.toolset as unknown as { pending: unknown }).pending = {
    kind: "completion",
    goalId: goal.goalId,
    revision: goal.revision,
    summary: "too early",
    proposedAt: new Date().toISOString(),
  };
  const kickoff = await r.continuation.onTurnEnd(activity());
  assert.deepEqual(kickoff, { action: "none", reason: "kickoff-delivered" });
  assert.equal(r.toolset.peekProposal(), null, "pending discarded with the kickoff");
  // And the next turn settles normally instead of tripping over stale state.
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "continue");
  rmSync(r.dir, { recursive: true, force: true });
});

test("a pending proposal is discarded when no drivable goal remains (FIX 2d)", async () => {
  const r = rig();
  await startGoal(r);
  proposeCompletion(r, "done");
  r.machine.clear(); // user stop outside the settlement
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "none");
  assert.equal(r.toolset.peekProposal(), null);
  assert.equal(r.sent.length, 1, "kickoff only");
  rmSync(r.dir, { recursive: true, force: true });
});

// ── UNI-123b: kanboard board contract rides goal continuations ───────────

const BOARD_LINE = "Kanboard: this session holds UNI-1 In Progress. Never leave a claimed task In Progress.";

test("boardLine is appended to the continuation hint", async () => {
  const r = rig([], { boardLine: () => BOARD_LINE });
  await startGoal(r);
  const decision = await r.continuation.onTurnEnd(activity());
  assert.equal(decision.action, "continue");
  const hint = r.sent.at(-1)!;
  assert.ok(hint.endsWith(BOARD_LINE), "hint must end with the board contract");
  assert.ok(hint.includes("\n\nKanboard:"), "blank-line separated");
  rmSync(r.dir, { recursive: true, force: true });
});

test("boardLine null leaves the hint unchanged", async () => {
  const r = rig([], { boardLine: () => null });
  await startGoal(r);
  await r.continuation.onTurnEnd(activity());
  const hint = r.sent.at(-1)!;
  assert.ok(!hint.includes("Kanboard:"), "clean board → no reminder");
  rmSync(r.dir, { recursive: true, force: true });
});

test("kickoff never carries the board line", async () => {
  const r = rig([], { boardLine: () => BOARD_LINE });
  r.machine.create("all tests pass");
  r.owner.activate("goal", "all tests pass");
  const kickoff = await r.continuation.onTurnEnd(activity());
  assert.deepEqual(kickoff, { action: "none", reason: "kickoff-delivered" });
  assert.equal(r.sent.length, 1);
  assert.ok(!r.sent[0]!.includes("Kanboard:"), "kickoff contract stays cache-stable");
  rmSync(r.dir, { recursive: true, force: true });
});
