import assert from "node:assert/strict";
import test from "node:test";
import { PrefixIntegrityTracker } from "../src/prefix-integrity.js";

const message = (role: string, content: string) => ({ role, content });
const payload = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  model: "deepseek-chat",
  messages,
  tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
  temperature: 0,
  ...extra,
});

test("classifies first, retry, and exact append-only extension", () => {
  const tracker = new PrefixIntegrityTracker();
  const first = payload([message("system", "stable"), message("user", "one")]);
  assert.equal(tracker.observe(first).verdict, "first_request");
  assert.equal(tracker.observe(structuredClone(first)).verdict, "identical_retry");
  const extended = tracker.observe(payload([...first.messages, message("assistant", "two"), message("user", "three")]));
  assert.equal(extended.verdict, "prefix_extended");
  assert.equal(extended.extendedBy, 2);
  assert.deepEqual(extended.differences, []);
});

test("reports exact middle injection, removal, and reorder positions", () => {
  const base = [message("system", "stable"), message("user", "one"), message("assistant", "two")];
  const injected = new PrefixIntegrityTracker();
  injected.observe(payload(base));
  const middle = injected.observe(payload([base[0], message("custom", "injected"), base[1], base[2]]));
  assert.equal(middle.verdict, "violation");
  assert.deepEqual(middle.differences[0], {
    surface: "messages", kind: "reordered", path: "$.messages[1]", index: 1,
    beforeFingerprint: middle.differences[0]?.beforeFingerprint,
    afterFingerprint: middle.differences[0]?.afterFingerprint,
  });

  const removed = new PrefixIntegrityTracker();
  removed.observe(payload(base));
  assert.equal(removed.observe(payload(base.slice(0, 2))).differences[0]?.kind, "removed");

  const reordered = new PrefixIntegrityTracker();
  reordered.observe(payload(base));
  const result = reordered.observe(payload([base[0], base[2], base[1]]));
  assert.equal(result.differences[0]?.kind, "reordered");
  assert.equal(result.differences[0]?.index, 1);
});

test("separates system, tools, and provider envelope drift", () => {
  const messages = [message("system", "stable"), message("user", "one")];
  const system = new PrefixIntegrityTracker();
  system.observe(payload(messages));
  assert.ok(system.observe(payload([message("system", "changed"), messages[1]])).differences.some(item => item.surface === "system"));

  const tools = new PrefixIntegrityTracker();
  tools.observe(payload(messages));
  assert.ok(tools.observe(payload(messages, { tools: [{ type: "function", function: { name: "write" } }] })).differences.some(item => item.surface === "tools"));

  const envelope = new PrefixIntegrityTracker();
  envelope.observe(payload(messages));
  assert.ok(envelope.observe(payload(messages, { temperature: 0.7 })).differences.some(item => item.surface === "envelope"));
});

test("classifies a changed earlier message as a prefix violation even when later content appends", () => {
  const tracker = new PrefixIntegrityTracker();
  tracker.observe(payload([message("user", "one"), message("assistant", "two")]));
  const result = tracker.observe(payload([message("user", "edited"), message("assistant", "two"), message("user", "three")]));
  assert.equal(result.verdict, "violation");
  assert.equal(result.differences[0]?.surface, "messages");
  assert.equal(result.differences[0]?.kind, "changed");
  assert.equal(result.differences[0]?.index, 0);
});

test("treats tool ordering as cache-significant", () => {
  const tracker = new PrefixIntegrityTracker();
  const messages = [message("user", "one")];
  const read = { type: "function", function: { name: "read" } };
  const write = { type: "function", function: { name: "write" } };
  tracker.observe(payload(messages, { tools: [read, write] }));
  const result = tracker.observe(payload(messages, { tools: [write, read] }));
  assert.equal(result.verdict, "violation");
  assert.ok(result.differences.some(item => item.surface === "tools"));
});

test("treats route changes as envelope drift", () => {
  const tracker = new PrefixIntegrityTracker();
  const messages = [message("user", "one")];
  tracker.observe(payload(messages), { provider: "a", model: "m", thinkingLevel: "low" });
  const result = tracker.observe(payload(messages), { provider: "b", model: "m", thinkingLevel: "low" });
  assert.equal(result.verdict, "violation");
  assert.ok(result.differences.some(item => item.surface === "envelope"));
});

test("explicit lifecycle boundaries start a clean append-only epoch", () => {
  const tracker = new PrefixIntegrityTracker();
  tracker.observe(payload([message("user", "before")]));
  tracker.markBoundary("session_compact:threshold");
  const boundary = tracker.observe(payload([message("user", "summary"), message("user", "after")]));
  assert.equal(boundary.verdict, "boundary");
  assert.equal(boundary.epoch, 2);
  assert.equal(boundary.boundaryReason, "session_compact:threshold");
  assert.equal(tracker.observe(payload([message("user", "summary"), message("user", "after"), message("assistant", "ok")])).verdict, "prefix_extended");
});
