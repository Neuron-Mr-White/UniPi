import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  installPendingWorkMonitor,
  resetPendingWorkMonitorForTests,
  pendingWorkLabel,
  hasPendingWork,
  PENDING_WORK_KEY,
} from "../pending-work.js";
import { registerWaitSource, resetArbiterForTests } from "../arbiter.js";
import { resetWorkChangesForTests } from "../../work/index.js";
import { resetHerdrWorkingForTests } from "../../../utils.js";

type Handler = (...args: unknown[]) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const emitted: Array<{ active: boolean; label: string }> = [];
  return {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    fire(name: string, ...args: unknown[]) {
      for (const fn of handlers.get(name) ?? []) fn(...args);
    },
    events: {
      emit(name: string, payload: unknown) {
        if (name === "herdr:working") emitted.push(payload as { active: boolean; label: string });
      },
    },
    emitted,
  };
}

beforeEach(() => {
  resetArbiterForTests();
  resetWorkChangesForTests();
  resetPendingWorkMonitorForTests();
  resetHerdrWorkingForTests();
  delete process.env.UNIPI_SUBAGENT_CHILD;
  delete process.env.UNIPI_FUSION_CHILD;
  delete process.env.UNIPI_KANBOARD_CHILD;
});

afterEach(() => {
  resetArbiterForTests();
  resetWorkChangesForTests();
  resetPendingWorkMonitorForTests();
  resetHerdrWorkingForTests();
});

describe("pendingWorkLabel / hasPendingWork", () => {
  test("null when no wait source has a reason", () => {
    assert.equal(pendingWorkLabel([]), null);
    assert.equal(hasPendingWork(), false);
  });

  test("joins every active reason", () => {
    registerWaitSource("background-tasks", () => "2 bg tasks will resume agent");
    registerWaitSource("subagents", () => "subagent running");
    registerWaitSource("fusion", () => null);
    const label = pendingWorkLabel();
    assert.equal(label, "2 bg tasks will resume agent · subagent running");
    assert.equal(hasPendingWork(), true);
  });

  test("a throwing wait source contributes nothing (never blocks)", () => {
    registerWaitSource("broken", () => {
      throw new Error("boom");
    });
    registerWaitSource("subagents", () => "subagent running");
    assert.equal(pendingWorkLabel(), "subagent running");
  });
});

describe("installPendingWorkMonitor", () => {
  test("claims herdr working on agent_settled while a wait source is pending", () => {
    const pi = fakePi();
    registerWaitSource("subagents", () => "subagent running");
    installPendingWorkMonitor(pi as never);
    pi.fire("agent_settled");
    assert.deepEqual(pi.emitted.at(-1), { active: true, label: "subagent running" });
  });

  test("clears the claim once every wait source returns null", () => {
    const pi = fakePi();
    let reason: string | null = "subagent running";
    registerWaitSource("subagents", () => reason);
    installPendingWorkMonitor(pi as never);
    pi.fire("agent_settled");
    assert.equal(pi.emitted.at(-1)?.active, true);
    reason = null;
    pi.fire("agent_settled");
    assert.equal(pi.emitted.at(-1)?.active, false);
  });

  test("agent_start clears any stale claim immediately", () => {
    const pi = fakePi();
    registerWaitSource("subagents", () => "subagent running");
    installPendingWorkMonitor(pi as never);
    pi.fire("agent_settled");
    assert.equal(pi.emitted.at(-1)?.active, true);
    pi.fire("agent_start");
    assert.equal(pi.emitted.at(-1)?.active, false);
  });

  test("is idempotent: the second install is a no-op", () => {
    const pi = fakePi();
    installPendingWorkMonitor(pi as never);
    installPendingWorkMonitor(pi as never);
    registerWaitSource("subagents", () => "subagent running");
    pi.fire("agent_settled");
    // Only ONE handler set fired — exactly one emission, not two.
    const activeEmits = pi.emitted.filter((e) => e.active);
    assert.equal(activeEmits.length, 1);
  });

  test("is a no-op in a child process", () => {
    process.env.UNIPI_SUBAGENT_CHILD = "1";
    const pi = fakePi();
    installPendingWorkMonitor(pi as never);
    registerWaitSource("subagents", () => "subagent running");
    pi.fire("agent_settled");
    assert.equal(pi.emitted.length, 0);
  });

  test("claims under the single PENDING_WORK_KEY label contract", () => {
    assert.equal(PENDING_WORK_KEY, "pending-work");
  });
});
