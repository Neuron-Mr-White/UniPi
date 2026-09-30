import test from "node:test";
import assert from "node:assert/strict";
import { pendingWakeReason } from "../index.js";

function task(overrides: Partial<{ status: string; triggerOnCompletion: boolean; command: string; name: string }> = {}) {
  return {
    status: "running",
    triggerOnCompletion: true,
    command: "npm test",
    name: "tests",
    ...overrides,
  };
}

test("pendingWakeReason: running task with a wake → reason", () => {
  assert.equal(pendingWakeReason([task()]), "bg: tests");
});

test("pendingWakeReason: multiple wake tasks → first + more", () => {
  const reason = pendingWakeReason([task({ name: "first" }), task({ name: "second" })]);
  assert.equal(reason, "bg: first +1 more");
});

test("pendingWakeReason: no wake → null", () => {
  assert.equal(pendingWakeReason([]), null);
  assert.equal(pendingWakeReason([task({ triggerOnCompletion: false })]), null, "no trigger → the agent will not wake");
  assert.equal(pendingWakeReason([task({ status: "completed" })]), null, "finished task → the wake already happened");
});
