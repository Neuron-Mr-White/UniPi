import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RunawayGuard,
  detectRunaway,
  errorFamily,
  runawayNudgeText,
  ANTI_POISONING_SUFFIX,
  type RunawayStep,
} from "../engine/runaway.js";
import { SwarmLedger, SWARM_ORCHESTRATION_PROMPT, registerSwarmTools } from "../tools/swarm.js";
import { OwnerCoordinator } from "../owner.js";

// ── runaway detectors ────────────────────────────────────────────────────

const step = (tool: string, input: unknown, resultText = "ok", isError = false): RunawayStep => ({
  tool,
  input,
  resultText,
  isError,
});

test("exact_action_repeat fires at threshold with identical input", () => {
  // Same action, DIFFERENT results each time — pure action repetition.
  const steps = [
    step("bash", { command: "npm test" }, "pass 1"),
    step("bash", { command: "npm test" }, "pass 2"),
    step("bash", { command: "npm test" }, "pass 3"),
  ];
  const observation = detectRunaway(steps);
  assert.equal(observation?.signal, "exact_action_repeat");
  assert.equal(observation?.occurrences, 3);
  // Different input → no signal (results also vary).
  assert.equal(detectRunaway([
    step("bash", { command: "a" }, "ra"),
    step("bash", { command: "b" }, "rb"),
    step("bash", { command: "c" }, "rc"),
  ]), null);
});

test("unchanged_progress_repeat when action AND result both repeat", () => {
  const steps = [
    step("bg_status", { id: "x" }, "running"),
    step("bg_status", { id: "x" }, "running"),
    step("bg_status", { id: "x" }, "running"),
  ];
  // bg_status polling is caught by exact_action first (same input);
  // identical action+result upgrades the classification:
  // Varying results → NOT unchanged progress, just action repeat:
  const varying = detectRunaway([
    step("bash", { command: "x" }, "r1"),
    step("bash", { command: "x" }, "r2"),
    step("bash", { command: "x" }, "r3"),
  ]);
  assert.equal(varying?.signal, "exact_action_repeat");
});

test("same_error_family normalizes paths and digits", () => {
  assert.equal(errorFamily("ENOENT: /tmp/foo/bar-3.txt not found\nmore"), "ENOENT: <path> not found");
  const steps = [
    step("bash", { command: "cat /tmp/a-1" }, "ENOENT: /tmp/a-1 not found", true),
    step("bash", { command: "cat /tmp/b-2" }, "ENOENT: /tmp/b-2 not found", true),
    step("bash", { command: "cat /tmp/c-3" }, "ENOENT: /tmp/c-3 not found", true),
  ];
  const observation = detectRunaway(steps);
  assert.equal(observation?.signal, "same_error_family");
});

test("abab_action_cycle detects strict alternation", () => {
  const steps = [
    step("read", { path: "a" }),
    step("edit", { path: "b" }),
    step("read", { path: "a" }),
    step("edit", { path: "b" }),
  ];
  const observation = detectRunaway(steps, 3);
  assert.equal(observation?.signal, "abab_action_cycle");
});

test("polling_repeat: status tools with varying args", () => {
  const steps = [
    step("bg_status", { taskId: "a" }, "task a: running"),
    step("bg_status", { taskId: "b" }, "task b: queued"),
    step("bg_status", { taskId: "c" }, "task c: running"),
  ];
  const observation = detectRunaway(steps);
  assert.equal(observation?.signal, "polling_repeat");
});

test("guard steers once per turn, then resets", () => {
  const steered: string[] = [];
  const guard = new RunawayGuard({ steer: (text) => steered.push(text) });
  const first = guard.feed(step("bash", { command: "x" }, "same"));
  assert.equal(first, null);
  const second = guard.feed(step("bash", { command: "x" }, "same"));
  assert.equal(second, null);
  const third = guard.feed(step("bash", { command: "x" }, "same"));
  assert.ok(third);
  assert.equal(steered.length, 1);
  assert.match(steered[0] ?? "", new RegExp(ANTI_POISONING_SUFFIX.slice(0, 30)));
  // Further feeds never steer again this turn.
  guard.feed(step("bash", { command: "x" }, "same"));
  assert.equal(steered.length, 1);
  // Next turn: fresh budget.
  guard.resetTurn();
  guard.feed(step("bash", { command: "x" }, "same"));
  guard.feed(step("bash", { command: "x" }, "same"));
  const again = guard.feed(step("bash", { command: "x" }, "same"));
  assert.ok(again);
  assert.equal(steered.length, 2);
});

test("nudge text names the signal and stays bounded", () => {
  for (const signal of ["exact_action_repeat", "polling_repeat", "abab_action_cycle"] as const) {
    const text = runawayNudgeText(signal, 4);
    assert.ok(text.length > 50 && text.length < 900);
    assert.ok(text.includes("No-progress guard"));
  }
});

// ── swarm ledger ─────────────────────────────────────────────────────────

function owner(): { coordinator: OwnerCoordinator; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lh-swarm-"));
  return { coordinator: new OwnerCoordinator({ statePath: () => join(dir, "owner.json") }), dir };
}

const items = [
  { itemId: "a", instruction: "review core" },
  { itemId: "b", instruction: "review storage" },
  { itemId: "c", instruction: "review docs" },
];

test("swarm start activates the owner and requires ≥2 items", () => {
  const { coordinator, dir } = owner();
  const ledger = new SwarmLedger(coordinator);
  const tooSmall = ledger.start("one item", [{ itemId: "a", instruction: "x" }]);
  assert.equal(tooSmall.ok, false);
  const started = ledger.start("review", items);
  assert.equal(started.ok, true);
  assert.equal(coordinator.getActive()?.kind, "swarm");
  rmSync(dir, { recursive: true, force: true });
});

test("dispatch claims are idempotent; re-dispatch only after failure", () => {
  const { coordinator, dir } = owner();
  const ledger = new SwarmLedger(coordinator);
  ledger.start("review", items);
  assert.equal(ledger.markDispatched("a").ok, true);
  assert.equal(ledger.markDispatched("a").ok, false); // double dispatch refused
  ledger.report("a", "failed", "provider 500");
  assert.equal(ledger.markDispatched("a").ok, true); // replacement allowed
  rmSync(dir, { recursive: true, force: true });
});

test("status projection: running → needs_attention → settled; report settles and finishes", () => {
  const { coordinator, dir } = owner();
  const ledger = new SwarmLedger(coordinator);
  ledger.start("review", items);
  ledger.markDispatched("a");
  ledger.markDispatched("b");
  let snap = ledger.snapshot();
  assert.equal(snap.status, "running");
  ledger.report("b", "failed", "crashed");
  snap = ledger.snapshot();
  assert.equal(snap.status, "needs_attention");
  ledger.markDispatched("b");
  ledger.report("a", "completed", "clean");
  ledger.report("c", "completed", "clean");
  const b = ledger.report("b", "completed", "fixed");
  assert.equal(b.ok, true);
  assert.equal(b.settled, true);
  assert.equal(ledger.snapshot().status, "settled");
  // Terminal re-report refused.
  const dup = ledger.report("a", "failed");
  assert.equal(dup.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestration prompt carries the Maka discipline", () => {
  assert.match(SWARM_ORCHESTRATION_PROMPT, /at least two meaningful independent items/);
  assert.match(SWARM_ORCHESTRATION_PROMPT, /Do not manufacture parallelism/);
  assert.match(SWARM_ORCHESTRATION_PROMPT, /swarm_yield/);
  assert.match(SWARM_ORCHESTRATION_PROMPT, /wake you/);
});

test("swarm tools register and close the owner on settle", async () => {
  const { coordinator, dir } = owner();
  const ledger = new SwarmLedger(coordinator);
  const registered: Array<{ name: string; execute: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }) =>
      registered.push({ name: tool.name, execute: (p) => tool.execute("id", p) }),
  } as never;
  registerSwarmTools(pi, { ledger, owner: coordinator });
  assert.deepEqual(registered.map((t) => t.name).sort(), ["swarm_report", "swarm_status", "swarm_yield"]);

  ledger.start("review", items.slice(0, 2));
  const done = await registered.find((t) => t.name === "swarm_report")!.execute({
    item_id: "a",
    status: "completed",
    summary: "ok",
  });
  assert.match(done.content[0]?.text ?? "", /Recorded a → completed/);
  const close = await registered.find((t) => t.name === "swarm_report")!.execute({
    item_id: "b",
    status: "completed",
  });
  assert.match(close.content[0]?.text ?? "", /All items settled/);
  assert.equal(coordinator.getActive(), undefined); // owner finished
  rmSync(dir, { recursive: true, force: true });
});
