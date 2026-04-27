/**
 * @pi-unipi/utility — Lifecycle tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessLifecycle, getLifecycle, disposeLifecycle } from "../src/lifecycle/process.ts";

describe("ProcessLifecycle", () => {
  it("starts in running state", () => {
    const lifecycle = new ProcessLifecycle({ handleSignals: false });
    assert.equal(lifecycle.currentState, "running");
    assert.equal(lifecycle.isShuttingDown, false);
    assert.equal(lifecycle.isOrphaned, false);
  });

  it("registers and unregisters cleanup", () => {
    const lifecycle = new ProcessLifecycle({ handleSignals: false });
    let called = false;
    const unregister = lifecycle.registerCleanup(() => {
      called = true;
    });

    assert.equal(typeof unregister, "function");
    unregister();

    // After unregister, shutdown should not call the cleanup
    lifecycle.shutdown("test");
    assert.equal(called, false);
  });

  it("runs cleanup on shutdown", async () => {
    const lifecycle = new ProcessLifecycle({ handleSignals: false });
    let called = false;
    lifecycle.registerCleanup(async () => {
      called = true;
    });

    await lifecycle.shutdown("test");
    assert.equal(called, true);
    // After shutdown completes, state is "error" (terminal state)
    assert.notEqual(lifecycle.currentState, "running");
  });

  it("runs multiple cleanups", async () => {
    const lifecycle = new ProcessLifecycle({ handleSignals: false });
    const calls: number[] = [];
    lifecycle.registerCleanup(() => { calls.push(1); });
    lifecycle.registerCleanup(() => { calls.push(2); });

    await lifecycle.shutdown("test");
    assert.deepEqual(calls, [1, 2]);
  });

  it("handles cleanup errors gracefully", async () => {
    const lifecycle = new ProcessLifecycle({ handleSignals: false });
    let secondCalled = false;
    lifecycle.registerCleanup(() => {
      throw new Error("boom");
    });
    lifecycle.registerCleanup(() => {
      secondCalled = true;
    });

    await lifecycle.shutdown("test");
    assert.equal(secondCalled, true);
  });
});

describe("getLifecycle / disposeLifecycle", () => {
  it("returns singleton", () => {
    disposeLifecycle();
    const a = getLifecycle({ handleSignals: false });
    const b = getLifecycle();
    assert.equal(a, b);
    disposeLifecycle();
  });
});
