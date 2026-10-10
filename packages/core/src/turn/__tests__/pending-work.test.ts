import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  installPendingWorkMonitor,
  resetPendingWorkMonitorForTests,
  pendingWorkLabel,
  hasPendingWork,
  PENDING_WORK_KEY,
  pendingWorkingLine,
  subscribePendingWork,
  WORKING_TITLE,
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

describe("UNI-221: pendingWorkingLine / subscribePendingWork", () => {
  test("one plain 'Working…' line with the reasons as detail", () => {
    assert.equal(pendingWorkingLine(null), null);
    assert.equal(pendingWorkingLine("bg: npm test"), "Working… · bg: npm test");
    assert.equal(pendingWorkingLine(""), WORKING_TITLE);
    registerWaitSource("subagents", () => "2 subagents working");
    assert.equal(pendingWorkingLine(), "Working… · 2 subagents working");
  });

  test("fires on start and end of pending work only (de-duped)", async () => {
    let reason: string | null = null;
    registerWaitSource("background-tasks", () => reason);
    const seen: Array<string | null> = [];
    const unsub = subscribePendingWork((l) => seen.push(l), { pollMs: 5 });
    try {
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(seen, [], "nothing pending, nothing changed");
      reason = "bg: sleep 30";
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(seen, ["bg: sleep 30"], "one notification for the start");
      reason = null;
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(seen, ["bg: sleep 30", null], "one for the end");
    } finally {
      unsub();
    }
  });

  test("a throwing listener never breaks the subscription", async () => {
    let reason: string | null = null;
    registerWaitSource("subagents", () => reason);
    let calls = 0;
    const unsub = subscribePendingWork(() => {
      calls += 1;
      throw new Error("boom");
    }, { pollMs: 5 });
    try {
      reason = "subagent working";
      await new Promise((r) => setTimeout(r, 25));
      reason = null;
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(calls, 2);
    } finally {
      unsub();
    }
  });
});
