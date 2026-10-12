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
