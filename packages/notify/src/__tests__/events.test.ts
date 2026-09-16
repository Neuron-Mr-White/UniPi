/**
 * Tests for the notify event dispatch path: suppression of intermediate agent
 * lifecycle notifications while a background-task wake is pending, and
 * per-event dispatch priority.
 */

import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { UNIPI_EVENTS } from "@pi-unipi/core";

import {
  disarmRenotify,
  hasPendingWakeTask,
  registerEventListeners,
  type DispatchNotification,
} from "../../events.ts";
import { DEFAULT_CONFIG } from "../../settings.ts";
import type { NotifyConfig, NotifyPriority } from "../../types.ts";
import {
  clearSharedTaskRegistry,
  setSharedTaskRegistry,
} from "../../../background-tasks/src/registry-shared.ts";

type Registry = Parameters<typeof setSharedTaskRegistry>[0];
type Handler = (payload?: unknown) => unknown;

function fakeRegistry(
  tasks: Array<{ status: string; triggerOnCompletion: boolean }>,
): Registry {
  return { allTasks: () => tasks } as unknown as Registry;
}

function fakeConfig(
  enabledEvents: string[],
  renotify?: Partial<NotifyConfig["renotify"]>,
): NotifyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const eventKey of enabledEvents) {
    config.events[eventKey] = { enabled: true, platforms: [] };
  }
  if (renotify) config.renotify = { ...config.renotify, ...renotify };
  return config;
}

interface DispatchCall {
  title: string;
  message: string;
  eventType: string;
  priority?: NotifyPriority;
}

function harness(config: NotifyConfig) {
  const calls: DispatchCall[] = [];
  const lifecycle = new Map<string, Handler[]>();
  const bus = new Map<string, Handler[]>();

  const pi = {
    on: (event: string, handler: Handler) => {
      const handlers = lifecycle.get(event) ?? [];
      handlers.push(handler);
      lifecycle.set(event, handlers);
    },
    events: {
      on: (event: string, handler: Handler) => {
        const handlers = bus.get(event) ?? [];
        handlers.push(handler);
        bus.set(event, handlers);
        return () => {};
      },
    },
  };

  const dispatch: DispatchNotification = async (
    _pi,
    title,
    message,
    _platforms,
    eventType,
    _config,
    _cwd,
    priority,
  ) => {
    calls.push({ title, message, eventType, priority });
    return { results: [], allSuccess: true };
  };

  registerEventListeners(
    pi as unknown as Parameters<typeof registerEventListeners>[0],
    config,
    process.cwd(),
    dispatch,
  );

  return { calls, lifecycle, bus };
}

async function invokeLifecycle(
  h: ReturnType<typeof harness>,
  event: string,
  payload?: unknown,
): Promise<void> {
  const handler = h.lifecycle.get(event)?.[0];
  assert.ok(handler, `no lifecycle handler registered for ${event}`);
  await handler(payload);
}

async function invokeBus(
  h: ReturnType<typeof harness>,
  event: string,
  payload?: unknown,
): Promise<void> {
  const handler = h.bus.get(event)?.[0];
  assert.ok(handler, `no bus handler registered for ${event}`);
  await handler(payload);
}

beforeEach(() => {
  clearSharedTaskRegistry();
  disarmRenotify();
});

after(() => {
  clearSharedTaskRegistry();
  disarmRenotify();
});

describe("notify — agent lifecycle suppression while a wake is pending", () => {
  it("does not dispatch agent_end when a triggerOnCompletion task is running", async () => {
    setSharedTaskRegistry(
      fakeRegistry([{ status: "running", triggerOnCompletion: true }]),
    );
    const h = harness(fakeConfig(["agent_end"]));

    await invokeLifecycle(h, "agent_end", {});

    assert.equal(h.calls.length, 0);
  });

  it("does not dispatch agent_settled when a triggerOnCompletion task is running", async () => {
    setSharedTaskRegistry(
      fakeRegistry([{ status: "running", triggerOnCompletion: true }]),
    );
    const h = harness(fakeConfig(["agent_settled"]));

    await invokeLifecycle(h, "agent_settled", {});

    assert.equal(h.calls.length, 0);
  });

  it("dispatches agent_end when running tasks do not trigger a wake", async () => {
    setSharedTaskRegistry(
      fakeRegistry([
        { status: "running", triggerOnCompletion: false },
        { status: "completed", triggerOnCompletion: true },
      ]),
    );
    const h = harness(fakeConfig(["agent_end"]));

    await invokeLifecycle(h, "agent_end", {});

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.eventType, "agent_end");
  });

  it("dispatches agent_end when no background-task registry is published", async () => {
    const h = harness(fakeConfig(["agent_end"]));

    await invokeLifecycle(h, "agent_end", {});

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.eventType, "agent_end");
  });

  it("dispatches agent_end when reading the registry throws", async () => {
    setSharedTaskRegistry({
      allTasks() {
        throw new Error("registry unavailable");
      },
    } as unknown as Registry);
    const h = harness(fakeConfig(["agent_end"]));

    await invokeLifecycle(h, "agent_end", {});

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.eventType, "agent_end");
  });

  it("reports no pending wake when no registry is available", () => {
    assert.equal(hasPendingWakeTask(), false);
  });

  it("runs the agent_end guard synchronously", () => {
    setSharedTaskRegistry(fakeRegistry([]));
    const h = harness(fakeConfig(["agent_end"]));
    const handler = h.lifecycle.get("agent_end")?.[0];
    assert.ok(handler, "no lifecycle handler registered for agent_end");

    const returned = handler({});

    assert.equal(returned, undefined, "handler must not return a promise");
    assert.equal(h.calls.length, 1, "dispatch should be observable without awaiting");
  });
});

describe("notify — event priority defaults", () => {
  it("dispatches permission_request with high priority", async () => {
    const h = harness(fakeConfig(["permission_request"]));

    await invokeBus(h, "permissions:ui_prompt", {
      surface: "bash",
      value: "npm test",
      agentName: "Current agent",
    });

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.eventType, "permission_request");
    assert.equal(h.calls[0]?.priority, "high");
  });

  it("dispatches ask_user_prompt with high priority on both buses", async () => {
    const h = harness(fakeConfig(["ask_user_prompt"]));

    await invokeBus(h, "rpiv:ask-user:prompt", {
      questions: [
        {
          question: "Which model?",
          header: "Model",
          multiSelect: false,
          options: [{ label: "opus", description: "", hasPreview: false }],
        },
      ],
    });
    await invokeBus(h, "unipi:ask-user:prompt", { question: "Which model?" });

    assert.equal(h.calls.length, 2);
    assert.deepEqual(
      h.calls.map((call) => call.priority),
      ["high", "high"],
    );
  });

  it("dispatches agent_end with low priority", async () => {
    const h = harness(fakeConfig(["agent_end"]));

    await invokeLifecycle(h, "agent_end", {});

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.priority, "low");
  });

  it("leaves other events without a priority override", async () => {
    const h = harness(fakeConfig(["workflow_end"]));

    await invokeBus(h, UNIPI_EVENTS.WORKFLOW_END, {
      command: "test",
      success: true,
    });

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.priority, undefined);
  });
});

// ─── Re-notify unanswered blocking prompts ────────────────────────────────

const RENOTIFY_INTERVAL = DEFAULT_CONFIG.renotify.intervalMs;

function armAskUser(h: ReturnType<typeof harness>): void {
  const handler = h.bus.get("rpiv:ask-user:prompt")?.[0];
  assert.ok(handler, "no rpiv ask-user handler registered");
  handler({ question: "Which model?" });
}

function armPermission(h: ReturnType<typeof harness>): void {
  const handler = h.bus.get("permissions:ui_prompt")?.[0];
  assert.ok(handler, "no permission handler registered");
  handler({ surface: "bash", value: "npm test" });
}

describe("notify — re-notify unanswered blocking prompts", () => {
  it("re-sends ask_user_prompt after intervalMs with a (still waiting) title", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["ask_user_prompt"]));

    armAskUser(h);
    assert.equal(h.calls.length, 1);

    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]?.title, "Pi — Question Asked (still waiting)");
    assert.equal(h.calls[1]?.message, h.calls[0]?.message);
    assert.equal(h.calls[1]?.eventType, "ask_user_prompt");
    assert.equal(h.calls[1]?.priority, "high");
  });

  it("re-sends permission_request after intervalMs with a (still waiting) title", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"]));

    armPermission(h);
    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]?.title, "Pi — Permission Request (still waiting)");
    assert.equal(h.calls[1]?.message, h.calls[0]?.message);
    assert.equal(h.calls[1]?.eventType, "permission_request");
    assert.equal(h.calls[1]?.priority, "high");
  });

  it("stops after maxRepeats fires", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["ask_user_prompt"], { maxRepeats: 2 }));

    armAskUser(h);
    t.mock.timers.tick(RENOTIFY_INTERVAL);
    t.mock.timers.tick(RENOTIFY_INTERVAL);
    assert.equal(h.calls.length, 3, "initial + 2 repeats");

    t.mock.timers.tick(RENOTIFY_INTERVAL);
    assert.equal(h.calls.length, 3, "no further repeats");
  });

  it("disarms on herdr:blocked active:false", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"]));
    armPermission(h);

    await invokeBus(h, "herdr:blocked", { active: false, label: "ask_user" });
    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 1);
  });

  it("does not disarm on herdr:blocked active:true", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"]));
    armPermission(h);

    await invokeBus(h, "herdr:blocked", { active: true, label: "ask_user" });
    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 2);
  });

  it("disarms on terminal input", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"]));
    armPermission(h);

    disarmRenotify();
    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 1);
  });

  it("disarms on agent_start", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"]));
    armPermission(h);

    await invokeLifecycle(h, "agent_start", {});
    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 1);
  });

  it("arming twice does not stack timers", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"]));

    armPermission(h);
    armPermission(h);
    t.mock.timers.tick(RENOTIFY_INTERVAL);

    assert.equal(h.calls.length, 3, "two initial dispatches + exactly one reminder");
  });

  it("never arms when disabled", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"], { enabled: false }));

    armPermission(h);
    t.mock.timers.tick(RENOTIFY_INTERVAL * 5);

    assert.equal(h.calls.length, 1);
  });

  it("maxRepeats:0 sends the initial notification only", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["permission_request"], { maxRepeats: 0 }));

    armPermission(h);
    t.mock.timers.tick(RENOTIFY_INTERVAL * 5);

    assert.equal(h.calls.length, 1);
  });

  it("does not arm for non-blocking events", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness(fakeConfig(["agent_end", "workflow_end"]));

    await invokeLifecycle(h, "agent_end", {});
    await invokeBus(h, UNIPI_EVENTS.WORKFLOW_END, { command: "test", success: true });
    t.mock.timers.tick(RENOTIFY_INTERVAL * 5);

    assert.equal(h.calls.length, 2);
  });
});
