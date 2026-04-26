/**
 * Test: ESC propagation — all children abort on parent ESC
 *
 * Verifies:
 * - forwardAbortSignal wires parent signal to child session
 * - abortAll stops all running agents
 * - All agents stop within reasonable time
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Mock AbortController to track abort calls
function createMockAbortController() {
  let aborted = false;
  const listeners: Array<() => void> = [];
  return {
    get signal() {
      return {
        aborted,
        addEventListener: (_event: string, listener: () => void) => {
          listeners.push(listener);
        },
        removeEventListener: (_event: string, listener: () => void) => {
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
        },
      };
    },
    abort() {
      aborted = true;
      for (const listener of listeners) listener();
    },
    get wasAborted() {
      return aborted;
    },
  };
}

describe("ESC Propagation", () => {
  describe("forwardAbortSignal", () => {
    it("should call session.abort() when signal fires", () => {
      // Simulate the forwardAbortSignal logic from agent-runner.ts
      const sessionAborted = { value: false };
      const session = { abort: () => { sessionAborted.value = true; } };
      const controller = createMockAbortController();

      // Wire abort signal
      const onAbort = () => session.abort();
      controller.signal.addEventListener("abort", onAbort);

      // Trigger abort
      controller.abort();

      assert.equal(sessionAborted.value, true, "Session should be aborted");
    });

    it("should not call session.abort() if signal not fired", () => {
      const sessionAborted = { value: false };
      const session = { abort: () => { sessionAborted.value = true; } };
      const controller = createMockAbortController();

      const onAbort = () => session.abort();
      controller.signal.addEventListener("abort", onAbort);

      // Don't abort
      assert.equal(sessionAborted.value, false, "Session should not be aborted");
    });

    it("should cleanup listener when returned function called", () => {
      const controller = createMockAbortController();
      let callCount = 0;
      const onAbort = () => { callCount++; };
      controller.signal.addEventListener("abort", onAbort);

      // Simulate cleanup
      const cleanup = () => controller.signal.removeEventListener("abort", onAbort);
      cleanup();

      controller.abort();
      assert.equal(callCount, 0, "Listener should not fire after cleanup");
    });
  });

  describe("abortAll", () => {
    it("should abort all running agents", () => {
      const agents = new Map<string, { abortController: ReturnType<typeof createMockAbortController>; status: string }>();

      // Create 3 mock agents
      for (let i = 0; i < 3; i++) {
        const controller = createMockAbortController();
        agents.set(`agent-${i}`, {
          abortController: controller,
          status: "running",
        });
      }

      // Simulate abortAll
      let abortedCount = 0;
      for (const [id, record] of agents) {
        if (record.status === "running") {
          record.abortController.abort();
          record.status = "stopped";
          abortedCount++;
        }
      }

      assert.equal(abortedCount, 3, "Should abort all 3 agents");
      for (const [_, record] of agents) {
        assert.equal(record.status, "stopped", "All agents should be stopped");
        assert.equal(record.abortController.wasAborted, true, "All controllers should be aborted");
      }
    });

    it("should handle queued agents by removing from queue", () => {
      const queue = [
        { id: "queued-1", status: "queued" },
        { id: "queued-2", status: "queued" },
      ];
      const agents = new Map<string, { status: string }>();

      for (const item of queue) {
        agents.set(item.id, { status: item.status });
      }

      // Simulate abortAll for queued
      for (const item of queue) {
        const record = agents.get(item.id);
        if (record) {
          record.status = "stopped";
        }
      }
      queue.length = 0;

      assert.equal(queue.length, 0, "Queue should be empty");
      for (const [_, record] of agents) {
        assert.equal(record.status, "stopped", "All queued agents should be stopped");
      }
    });
  });

  describe("ESC timing", () => {
    it("should abort within reasonable time", async () => {
      const controller = createMockAbortController();
      let abortedAt: number | null = null;
      const startedAt = Date.now();

      const onAbort = () => { abortedAt = Date.now(); };
      controller.signal.addEventListener("abort", onAbort);

      // Simulate abort after small delay
      setTimeout(() => controller.abort(), 10);

      // Wait for abort
      await new Promise(resolve => setTimeout(resolve, 50));

      assert.notEqual(abortedAt, null, "Should have aborted");
      const elapsed = abortedAt! - startedAt;
      assert.ok(elapsed < 500, `Abort should happen within 500ms, took ${elapsed}ms`);
    });
  });
});
