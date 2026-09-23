/**
 * Watchdog extension integration — tool_result rewrite for a killed id only,
 * enabled=false costs nothing, otherTools warn/abort-turn, bg kill reason.
 * Uses a fake pi + real stubbed fetch (no network).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface FakeRegistryTask {
  id: string;
  command: string;
  status: string;
  startTime: number;
  pid?: number;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  outputTail?: string[];
  delegate?: unknown;
}

describe("watchdog extension", () => {
  let home: string;
  let origHome: string | undefined;
  let handlers: Record<string, Handler>;
  let appended: Array<{ customType: string; data?: unknown }>;
  let notifications: Array<{ title?: string; message: string; priority?: string }>;
  let registryTasks: Map<string, FakeRegistryTask>;
  let stopped: Array<{ id: string; reason: string }>;
  let aborted: number;
  let sent: Array<{ content: string }>;

  function fakePi(): unknown {
    handlers = {};
    appended = [];
    notifications = [];
    return {
      on: (event: string, handler: Handler) => { handlers[event] = handler; },
      appendEntry: (customType: string, data?: unknown) => { appended.push({ customType, data }); },
      sendMessage: (message: { content: string }) => { sent.push({ content: message.content }); },
      sendUserMessage: (content: string) => { sent.push({ content }); },
      registerCommand: () => {},
    };
  }

  function fakeCtx(): unknown {
    return {
      hasUI: true,
      cwd: process.cwd(),
      cwd: process.cwd(),
      ui: {
        setStatus: () => {},
        notify: (message: string, _priority?: string) => { notifications.push({ message }); },
        confirm: async () => true,
        input: async () => "y",
      },
      sessionManager: { getSessionId: () => "watch-sess", getEntries: () => [] },
      abort: () => { aborted++; },
      sendUserMessage: (content: string) => { sent.push({ content }); },
    };
  }

  function setEngineSettings(patch: Record<string, unknown>): void {
    const core = require_core();
    core.setSettings("watchdog", patch, "global", process.cwd());
  }

  let coreModule: typeof import("@pi-unipi/core");
  function require_core(): typeof import("@pi-unipi/core") {
    return coreModule;
  }

  let watchdogMod: {
    registerWatchdogExtension: (pi: unknown) => void;
    applyKill: (event: unknown) => unknown;
    resetWatchdogState: () => void;
    setRegistryTasks: (tasks: FakeRegistryTask[]) => void;
  };

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-ext-"));
    origHome = process.env.HOME;
    process.env.HOME = home;
    coreModule = await import("@pi-unipi/core");
    // long-horizon namespace for the judge settings the watchdog reads
    await import("@pi-unipi/long-horizon/src/settings.js");
    const { setSettings: setLh } = await import("@pi-unipi/core");
    setLh("long-horizon", { judge: { provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "test-key", baseUrl: "", timeoutMs: 200 } }, "global", process.cwd());
    const { setSharedTaskRegistry } = await import("@pi-unipi/background-tasks");
    registryTasks = new Map();
    stopped = [];
    aborted = 0;
    sent = [];
    const registryStub = {
      allTasks: () => [...registryTasks.values()],
      stopTask: async (task: FakeRegistryTask, _kind: string, reason: string) => {
        stopped.push({ id: task.id, reason });
        const t = registryTasks.get(task.id)!;
        t.status = "killed";
        return t;
      },
    };
    (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for("unipi.background-tasks.shared-registry")
    ] = registryStub;
    void setSharedTaskRegistry;

    watchdogMod = (await import("../index.js")) as typeof import("../index.js");
    watchdogMod.setRegistryTasks([...registryTasks.values()]);
    watchdogMod.registerWatchdogExtension(fakePi());
  });

  afterEach(() => {
    watchdogMod.resetWatchdogState();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("tool_result rewrite: killed id gets the ⚠ reason prepended + isError; other ids untouched", async () => {
    watchdogMod.__recordKill("call-1", {
      durationMs: 95_000,
      reason: "stuck (confidence 0.92) on 2 consecutive checks — no new output for 95s",
    });
    assert.ok(handlers["tool_result"], "tool_result handler registered");
    const toolResult = handlers["tool_result"]!;

    const killed = await toolResult({
      type: "tool_result", toolCallId: "call-1", toolName: "bash",
      input: { command: "npm run dev" },
      content: [{ type: "text", text: "some partial output" }],
      isError: false,
    });
    const killedResult = killed as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(killedResult.isError, true);
    assert.ok(killedResult.content[0]!.text.includes("⚠ Killed by unipi watchdog after 95s"));
    assert.ok(killedResult.content[0]!.text.includes("stuck (confidence 0.92) on 2 consecutive checks"));
    assert.ok(killedResult.content[0]!.text.includes("some partial output"), "original output preserved");

    const other = await toolResult({
      type: "tool_result", toolCallId: "call-2", toolName: "bash",
      input: { command: "ls" },
      content: [{ type: "text", text: "files" }],
      isError: false,
    });
    assert.equal(other, undefined, "non-killed id untouched (no override = pi default)");
  });

  it("enabled=false → tick returns early, no jev call", async () => {
    watchdogMod.registerWatchdogExtension(fakePi());
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = () => { calls++; return new Response("{}", { status: 200 }); };
    setEngineSettings({ enabled: false });
    const sessionStart = handlers["session_start"]!;
    await sessionStart({ type: "session_start", reason: "startup" }, fakeCtx());
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    assert.equal(calls, 0, "disabled → no jev call");
  });

  it("otherTools=warn: stuck tool gets a pending message the agent sees next turn", async () => {
    watchdogMod.registerWatchdogExtension(fakePi());
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response(JSON.stringify({
        answers: {
          status: { choice: "stuck", confidence: 0.95 },
          persistent: { noul: 0.0 },
        },
      }), { status: 200 });
    setEngineSettings({ enabled: true, watchBash: false, watchBgTasks: false, otherTools: "warn", agreeChecks: 1 });
    const sessionStart = handlers["session_start"]!;
    await sessionStart({ type: "session_start", reason: "startup" }, fakeCtx());
    const toolStart = handlers["tool_execution_start"]!;
    await toolStart({ type: "tool_execution_start", toolCallId: "mcp-1", toolName: "mcp__search", args: { q: "x" } }, fakeCtx());
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    const beforeAgent = handlers["before_agent_start"]!;
    const result = (await beforeAgent({
      type: "before_agent_start", prompt: "next prompt", systemPrompt: "sp",
    }, fakeCtx())) as { message?: { content: string; display: boolean } } | undefined;
    assert.ok(result?.message, "agent sees the watchdog message next turn");
    assert.ok(result.message.content.includes("mcp__search"), "names the tool");
    assert.ok(result.message.display, "display true");
  });

  it("bg task kill carries the reason; persistent tasks are never checked", async () => {
    registryTasks.set("task-loop", {
      id: "task-loop", command: "while true; do echo err; done", status: "running",
      startTime: Date.now() - 300_000, pid: 424242, notifyOnCompletion: true,
      triggerOnCompletion: true, outputTail: ["Error: connection refused, retrying"],
    });
    registryTasks.set("task-server", {
      id: "task-server", command: "python3 -m http.server", status: "running",
      startTime: Date.now() - 300_000, pid: 424243, notifyOnCompletion: false,
      triggerOnCompletion: false, outputTail: ["Serving on :8000"],
    });
    watchdogMod.setRegistryTasks([...registryTasks.values()]);
    let callIdx = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      const persistent = callIdx === 0; // first call = task-server (persistent)
      callIdx++;
      return new Response(JSON.stringify({
        answers: {
          status: { choice: persistent ? "waiting" : "looping", confidence: 0.95 },
          persistent: { noul: persistent ? 0.9 : 0.0 },
        },
      }), { status: 200 });
    };
    setEngineSettings({ enabled: true, watchBgTasks: true, intervalMin: 0.01, firstCheckMin: 0.01, agreeChecks: 1 });
    const sessionStart = handlers["session_start"]!;
    await sessionStart({ type: "session_start", reason: "startup" }, fakeCtx());
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    assert.equal(stopped.length, 0, "persistent task never stopped");
    // tick again for the non-persistent task (tick processes both, persistent vetoed)
    await tickFn(fakeCtx());
    assert.ok(stopped.some((s) => s.id === "task-loop" && s.reason.includes("killed by unipi watchdog:")), "looping task killed with reason");
    assert.ok(!stopped.some((s) => s.id === "task-server"), "persistent task not stopped");
  });

  it("bg kill carries the watchdog reason into stopTask", async () => {
    registryTasks.set("task-loop", {
      id: "task-loop", command: "while true; do echo err; done", status: "running",
      startTime: Date.now() - 300_000, pid: 424242, notifyOnCompletion: true,
      triggerOnCompletion: true, outputTail: ["Error: connection refused, retrying"],
    });
    watchdogMod.setRegistryTasks([...registryTasks.values()]);
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response(JSON.stringify({
        answers: {
          status: { choice: "looping", confidence: 0.95 },
          persistent: { noul: 0.05 },
        },
      }), { status: 200 });
    setEngineSettings({ enabled: true, watchBgTasks: true, agreeChecks: 1, confidence: 0.8 });
    const sessionStart = handlers["session_start"]!;
    await sessionStart({ type: "session_start", reason: "startup" }, fakeCtx());
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    assert.equal(stopped.length, 1, "looping bg task stopped");
    assert.ok(stopped[0]!.reason.includes("killed by unipi watchdog:"), "reason recorded");
    assert.ok(stopped[0]!.reason.includes("looping"), "status in reason");
  });
});
