import { strict as assert } from "node:assert";
import { test } from "node:test";
import { backgroundRunningReason, type SubagentRecord } from "../manager.js";

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "agent-1",
    title: "spike",
    profile: "explore",
    model: "zai/glm-5.3-flash",
    status: "running",
    background: true,
    startedAt: Date.now(),
    toolCalls: 0,
    lastActivity: Date.now(),
    sessionFile: "/tmp/spike/agent-1.jsonl",
    depth: 1,
    ...overrides,
  };
}

test("background running subagent → wait reason", () => {
  assert.equal(backgroundRunningReason([record()]), "background subagent running");
});

test("no background running subagent → null", () => {
  assert.equal(backgroundRunningReason([]), null);
  assert.equal(
    backgroundRunningReason([record({ background: false })]),
    null,
    "a foreground run blocks the lead inside the tool call, never at settle",
  );
  assert.equal(
    backgroundRunningReason([record({ status: "completed" })]),
    null,
    "a finished background run already delivered its wake",
  );
});

test("mixed records: one background running is enough", () => {
  const all = [
    record({ id: "a", status: "completed" }),
    record({ id: "b", background: false, status: "running" }),
    record({ id: "c", status: "running" }),
  ];
  assert.equal(backgroundRunningReason(all), "background subagent running");
});
