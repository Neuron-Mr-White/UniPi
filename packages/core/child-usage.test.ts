import { test } from "node:test";
import assert from "node:assert/strict";
import { CHILD_USAGE_ENTRY, childUsageOf, onChildUsage, recordChildUsage, type ChildUsageData } from "./src/child-usage.js";

test("recordChildUsage appends a custom entry and notifies listeners", () => {
  const appended: Array<{ type: string; data: ChildUsageData }> = [];
  const heard: ChildUsageData[] = [];
  const off = onChildUsage((d) => heard.push(d));
  recordChildUsage((type, data) => appended.push({ type, data }), { source: "subagent", id: "a1", model: "p/m" }, { input: 10, output: 2, cost: 0.3 });
  off();
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.type, CHILD_USAGE_ENTRY);
  assert.equal(appended[0]!.data.cost, 0.3);
  assert.equal(appended[0]!.data.standalone, true);
  assert.equal(heard.length, 1);
});

test("recordChildUsage skips empty deltas and survives a dead session", () => {
  const appended: unknown[] = [];
  recordChildUsage((t, d) => appended.push([t, d]), { source: "fusion", id: "s" }, { input: 0, cost: Number.NaN });
  assert.equal(appended.length, 0);
  assert.doesNotThrow(() => recordChildUsage(() => { throw new Error("gone"); }, { source: "fusion", id: "s" }, { cost: 1 }));
});

test("childUsageOf reads only unipi-child-usage custom entries", () => {
  assert.equal(childUsageOf({ type: "message", message: { role: "assistant" } }), undefined);
  assert.equal(childUsageOf({ type: "custom", customType: "subagent-step", data: {} }), undefined);
  const d = childUsageOf({ type: "custom", customType: CHILD_USAGE_ENTRY, data: { source: "bg-task", id: "t", standalone: false, cost: 0.2, input: -5 } });
  assert.equal(d?.cost, 0.2);
  assert.equal(d?.input, 0);
  assert.equal(d?.standalone, false);
});
