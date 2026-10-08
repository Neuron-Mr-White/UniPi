import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  listWorkItems,
  runningWorkCount,
  stopWorkItem,
  backgroundWorkItem,
  subscribeWorkChanges,
  resetWorkChangesForTests,
} from "../index.js";
import { bus, resetBusForTests } from "../../../bus.js";
import { UNIPI_EVENTS } from "../../../events.js";

const BG_REGISTRY_KEY = Symbol.for("unipi.background-tasks.shared-registry");
const BG_CHANGE_KEY = Symbol.for("unipi.background-tasks.shared-registry-changed");
const SUBAGENT_MANAGER_KEY = Symbol.for("unipi.subagents.shared-manager");
const SUBAGENT_LIST_KEY = Symbol.for("unipi.subagents.shared-list");
const SUBAGENT_SUBSCRIBE_KEY = Symbol.for("unipi.subagents.shared-subscribe");

function clearGlobals(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  delete g[BG_REGISTRY_KEY];
  delete g[BG_CHANGE_KEY];
  delete g[SUBAGENT_MANAGER_KEY];
  delete g[SUBAGENT_LIST_KEY];
  delete g[SUBAGENT_SUBSCRIBE_KEY];
}

beforeEach(() => {
  clearGlobals();
  resetBusForTests();
  resetWorkChangesForTests();
});

afterEach(() => {
  clearGlobals();
  resetBusForTests();
  resetWorkChangesForTests();
});

describe("listWorkItems", () => {
  test("empty when nothing is installed", () => {
    assert.deepEqual(listWorkItems(), []);
    assert.equal(runningWorkCount(), 0);
  });

  test("reads bg tasks off the shared registry", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[BG_REGISTRY_KEY] = {
      allTasks: () => [{ id: "t1" }],
      snapshot: () => ({ id: "t1", command: "npm test", status: "running", startTime: 1000 }),
      resolveTask: (id: string) => ({ id }),
      stopTask: async (t: { id: string }) => t,
      getTaskLogs: async () => ({ text: "", details: { truncated: false } }),
    };
    const items = listWorkItems();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "bg");
    assert.equal(items[0]?.dot, "running");
    assert.equal(runningWorkCount(), 1);
  });

  test("reads subagents off the shared list fn", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[SUBAGENT_LIST_KEY] = () => [
      { id: "a1", title: "Explore", status: "completed", background: false, startedAt: 500, endedAt: 600 },
    ];
    const items = listWorkItems();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "subagent");
    assert.equal(items[0]?.dot, "done");
  });

  test("reads sidekick off the bus FUSION_STATUS", () => {
    bus.emit(UNIPI_EVENTS.FUSION_STATUS, {
      leadName: "lead", leadEffort: "medium", sidekickName: "side", sidekickEffort: "low", busy: true,
    });
    const items = listWorkItems();
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "sidekick");
    assert.equal(items[0]?.dot, "running");
  });

  test("running items sort before finished, then newest-started first", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[SUBAGENT_LIST_KEY] = () => [
      { id: "a1", title: "old done", status: "completed", background: false, startedAt: 100 },
      { id: "a2", title: "new done", status: "completed", background: false, startedAt: 200 },
      { id: "a3", title: "running", status: "running", background: false, startedAt: 50 },
    ];
    const items = listWorkItems();
    assert.deepEqual(items.map((i) => i.id), ["agent-a3", "agent-a2", "agent-a1"]);
  });

  test("a broken producer never throws, just contributes nothing", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[BG_REGISTRY_KEY] = {
      allTasks: () => {
        throw new Error("boom");
      },
    };
    assert.deepEqual(listWorkItems(), []);
  });
});

describe("stopWorkItem / backgroundWorkItem", () => {
  test("stops a bg task via the registry", async () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const stop = mock.fn(async (t: { id: string }) => t);
    g[BG_REGISTRY_KEY] = {
      allTasks: () => [],
      snapshot: () => ({ id: "t1", command: "x", status: "running", startTime: 0 }),
      resolveTask: (id: string) => ({ id }),
      stopTask: stop,
      getTaskLogs: async () => ({ text: "", details: { truncated: false } }),
    };
    const result = await stopWorkItem("bg-t1");
    assert.deepEqual(result, { ok: true });
    assert.equal(stop.mock.callCount(), 1);
  });

  test("cancels a subagent via the manager", async () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const cancel = mock.fn(() => true);
    g[SUBAGENT_MANAGER_KEY] = { run: () => undefined, cancel, setBackground: () => {} };
    const result = await stopWorkItem("agent-a1");
    assert.deepEqual(result, { ok: true });
    assert.equal(cancel.mock.callCount(), 1);
  });

  test("backgrounds a running subagent", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const setBackground = mock.fn();
    g[SUBAGENT_MANAGER_KEY] = { run: () => ({}), cancel: () => false, setBackground };
    const result = backgroundWorkItem("agent-a1");
    assert.deepEqual(result, { ok: true });
    assert.equal(setBackground.mock.callCount(), 1);
  });

  test("sidekick items can't be stopped or backgrounded", async () => {
    assert.deepEqual(await stopWorkItem("sidekick"), { ok: false, message: "This item can't be stopped." });
    assert.deepEqual(backgroundWorkItem("sidekick"), { ok: false, message: "Only subagents can be sent to the background." });
  });
});

describe("subscribeWorkChanges", () => {
  test("fires when the subagents subscribe hook fires", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    let fire: (() => void) | undefined;
    g[SUBAGENT_SUBSCRIBE_KEY] = (listener: () => void) => {
      fire = listener;
      return () => {
        fire = undefined;
      };
    };
    let calls = 0;
    const unsub = subscribeWorkChanges(() => {
      calls += 1;
    });
    assert.ok(fire);
    fire?.();
    assert.equal(calls, 1);
    unsub();
    assert.equal(fire, undefined);
  });

  test("fires when the bg registry change hook fires", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const changeSet = new Set<() => void>();
    g[BG_CHANGE_KEY] = changeSet;
    let calls = 0;
    const unsub = subscribeWorkChanges(() => {
      calls += 1;
    });
    assert.equal(changeSet.size, 1);
    for (const l of changeSet) l();
    assert.equal(calls, 1);
    unsub();
    assert.equal(changeSet.size, 0);
  });

  test("last unsubscribe tears down the wiring", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    const changeSet = new Set<() => void>();
    g[BG_CHANGE_KEY] = changeSet;
    const unsub1 = subscribeWorkChanges(() => {});
    const unsub2 = subscribeWorkChanges(() => {});
    assert.equal(changeSet.size, 1); // one wiring listener shared by both subscribers
    unsub1();
    assert.equal(changeSet.size, 1); // still wired while a listener remains
    unsub2();
    assert.equal(changeSet.size, 0); // torn down once the last listener leaves
  });
});
