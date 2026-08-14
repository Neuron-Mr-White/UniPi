import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrefixCacheTracker, formatPrefixCacheStats } from "../src/prefix-cache.ts";

const KEY = new Uint8Array(32).fill(7);

function payload(messages: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    model: "deepseek-chat",
    messages,
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    temperature: 0,
    ...overrides,
  };
}

function assistant(id: string, usage: Record<string, number>) {
  return {
    role: "assistant",
    content: [{ type: "text", text: id }],
    stopReason: "stop",
    usage,
    timestamp: 0,
  };
}

describe("PrefixCacheTracker", () => {
  it("classifies exact prefix extensions, retries, envelope changes, and history rewrites", () => {
    const tracker = new PrefixCacheTracker(KEY);
    const route = { provider: "deepseek", id: "deepseek-chat", api: "openai-completions" };
    const first = payload([{ role: "user", content: "one" }]);

    assert.equal(tracker.observeRequest(first, route).lastTransition, "first_request");
    assert.equal(tracker.observeRequest(first, route).lastTransition, "identical_retry");
    assert.equal(
      tracker.observeRequest(payload([...first.messages, { role: "assistant", content: "two" }]), route).lastTransition,
      "prefix_extended",
    );
    assert.equal(
      tracker.observeRequest(payload([{ role: "user", content: "replacement" }]), route).lastTransition,
      "history_rewritten",
    );
    assert.equal(
      tracker.observeRequest(payload([{ role: "user", content: "replacement" }], { temperature: 0.7 }), route).lastTransition,
      "envelope_changed",
    );

    const snapshot = tracker.getSnapshot();
    assert.equal(snapshot.requests, 5);
    assert.equal(snapshot.identicalRetries, 1);
    assert.equal(snapshot.prefixExtensions, 1);
    assert.equal(snapshot.boundaries, 2);
    assert.equal(snapshot.epoch, 3);
  });

  it("canonicalizes object keys but preserves order-sensitive arrays", () => {
    const first = new PrefixCacheTracker(KEY);
    const second = new PrefixCacheTracker(KEY);
    const a = first.observeRequest({ messages: [{ b: 2, a: 1 }], tools: [{ z: 1, a: 2 }] });
    const b = second.observeRequest({ tools: [{ a: 2, z: 1 }], messages: [{ a: 1, b: 2 }] });
    assert.equal(a.requestFingerprint, b.requestFingerprint);

    const third = new PrefixCacheTracker(KEY);
    const c = third.observeRequest({ messages: [{ values: [2, 1] }] });
    assert.notEqual(a.requestFingerprint, c.requestFingerprint);
  });

  it("deduplicates assistant usage and exposes cache read/write counters", () => {
    const tracker = new PrefixCacheTracker(KEY);
    const message = assistant("done", {
      input: 100,
      output: 10,
      cacheRead: 900,
      cacheWrite: 25,
    });

    tracker.observeMessages([message]);
    tracker.observeMessages([message]);
    tracker.observeMessages([assistant("next", {
      input: 50,
      output: 5,
      cacheRead: 450,
      cacheWrite: 0,
    })]);

    const snapshot = tracker.getSnapshot();
    assert.deepEqual(snapshot.usage, {
      input: 150,
      output: 15,
      cacheRead: 1350,
      cacheWrite: 25,
      responses: 2,
    });
    assert.match(formatPrefixCacheStats(snapshot), /Provider cache read: 1350 tokens/);
    assert.match(formatPrefixCacheStats(snapshot), /session-local keyed HMACs/);
  });

  it("counts distinct identical provider responses while deduplicating repeated context objects", () => {
    const tracker = new PrefixCacheTracker(KEY);
    const first = assistant("same", { input: 10, output: 1, cacheRead: 90, cacheWrite: 0 });
    const second = structuredClone(first);

    tracker.observeMessages([first]);
    tracker.observeMessages([first, second]);

    assert.deepEqual(tracker.getSnapshot().usage, {
      input: 20,
      output: 2,
      cacheRead: 180,
      cacheWrite: 0,
      responses: 2,
    });
  });

  it("never exposes raw prompt or tool argument text in snapshots or reports", () => {
    const tracker = new PrefixCacheTracker(KEY);
    const secret = "super-secret-prompt-value";
    const snapshot = tracker.observeRequest(payload([{ role: "user", content: secret }], {
      tools: [{ arguments: { token: secret } }],
    }));

    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
    assert.doesNotMatch(formatPrefixCacheStats(snapshot), new RegExp(secret));
    assert.match(snapshot.requestFingerprint, /^[0-9a-f]{16}$/);
  });

  it("advances explicit lifecycle boundaries without double-comparing old history", () => {
    const tracker = new PrefixCacheTracker(KEY);
    tracker.observeRequest(payload([{ role: "user", content: "before" }]));
    tracker.markBoundary("history_rewritten");
    const after = tracker.observeRequest(payload([{ role: "user", content: "after" }]));

    assert.equal(after.epoch, 2);
    assert.equal(after.boundaries, 1);
    assert.equal(after.lastTransition, "first_request");
  });
});
