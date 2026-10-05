/**
 * Watchdog "background" action — moves a stuck bash call to a background
 * task via core's `detachBashCall`/`detachCurrentBashCall`, instead of
 * killing it. Covers the forced-act test hook, the success path (adopted,
 * no kill), the unavailable-adopter fallback to kill, and the manual
 * `/unipi:bg-detach` command.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  createDetachableBashOperations,
  withDetachableBash,
  setBashBackgroundAdopter,
  setSettings,
} from "@pi-unipi/core";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> };

describe("watchdog — background action (detach)", () => {
  let home: string;
  let origHome: string | undefined;
  let origForce: string | undefined;
  let handlers: Record<string, Handler>;
  let commands: Record<string, Command>;
  let watchdogMod: {
    registerWatchdogExtension: (pi: unknown) => void;
    resetWatchdogState: () => void;
    __watchdogTick: (ctx: unknown) => Promise<void>;
    __getKills: () => Map<string, unknown>;
    __setClock: (fn: (() => number) | null) => void;
  };

  function fakePi(): unknown {
    handlers = {};
    commands = {};
    return {
      on: (event: string, handler: Handler) => { handlers[event] = handler; },
      registerCommand: (name: string, options: Command) => { commands[name] = options; },
      appendEntry: () => {},
    };
  }

  function fakeCtx(notes: Array<{ text: string; level: string }> = []): unknown {
    return {
      hasUI: true, cwd: process.cwd(),
      ui: { setStatus: () => {}, notify: (text: string, level: string) => notes.push({ text, level }) },
      sessionManager: { getSessionId: () => "s", getEntries: () => [] },
      abort: () => {}, sendUserMessage: () => {},
    };
  }

  function bashDefinition() {
    return withDetachableBash(
      createBashToolDefinition(process.cwd(), { operations: createDetachableBashOperations() }) as never,
    );
  }

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "wd-detach-test-"));
    origHome = process.env.HOME;
    process.env.HOME = home;
    origForce = process.env.UNIPI_WATCHDOG_FORCE_ACT;
    watchdogMod = (await import("../index.js")) as typeof watchdogMod;
    watchdogMod.registerWatchdogExtension(fakePi());
  });

  afterEach(() => {
    watchdogMod.resetWatchdogState();
    setBashBackgroundAdopter(null);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origForce === undefined) delete process.env.UNIPI_WATCHDOG_FORCE_ACT;
    else process.env.UNIPI_WATCHDOG_FORCE_ACT = origForce;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function enableJudge(watchdog: Record<string, unknown>): Promise<void> {
    await import("@pi-unipi/long-horizon/src/settings.js");
    setSettings("long-horizon", { judge: { provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "test-key", baseUrl: "" } }, "global", process.cwd());
    setSettings("watchdog", { enabled: true, confidence: 0.8, agreeChecks: 5, watchBash: true, watchBgTasks: true, ...watchdog }, "global", process.cwd());
  }

  function stubJev(status: string): void {
    (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({
      answers: { status: { choice: status, confidence: 0.95 }, persistent: { noul: 0.0 } },
    }), { status: 200 });
  }

  it("UNIPI_WATCHDOG_FORCE_ACT=1 forces the act branch on the very first tick", async () => {
    await enableJudge({ action: "warn", firstCheckMin: 0, intervalMin: 0.5 });
    stubJev("progressing"); // would normally never act
    process.env.UNIPI_WATCHDOG_FORCE_ACT = "1";
    watchdogMod.__setClock(() => 1_000_000);

    const notes: Array<{ text: string; level: string }> = [];
    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-force", toolName: "bash", args: { command: "sleep 300" } },
      fakeCtx(),
    );
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx(notes));
    // action "warn" + forced act → pending warning queued (checked via before_agent_start drain).
    const drained = await handlers["before_agent_start"]!({ prompt: "", systemPrompt: "" }, fakeCtx());
    assert.ok(drained, "forced act produced a warning even though jev said 'progressing'");
  });

  it("action: background — detachBashCall succeeds: no kill recorded, task adopted", async () => {
    await enableJudge({ action: "background", confidence: .5, agreeChecks: 2, firstCheckMin: 0, intervalMin: 0.5 });
    const states: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      states.push(body.state ?? body.messages?.map((m: { content: string }) => m.content).join("\n") ?? JSON.stringify(body));
      return new Response(JSON.stringify({ answers: { expect: { choice: "minutes" }, status: { choice: "stuck", confidence: .9 }, stop: { noul: .8 } } }));
    };
    watchdogMod.__setClock(() => 2_000_000);
    watchdogMod.__setSampler(async () => ({ processes: [{ pid: 1, ppid: 0, comm: "python3", cmdline: "work", state: "S", wchan: "futex_do_wait", fd0: "/dev/null", cpu_pct: 0, io: { read_bytes: 0, write_bytes: 0, rchar: 0, wchar: 0 }, sockets: [], children: 0 }], group_totals: { cpu_pct: 0, read_bytes: 0, write_bytes: 0, rchar: 0, wchar: 0, any_running: false, io_bytes: 0 }, cumulative_io: 0 }));

    const { BackgroundTaskRegistry } = await import("@pi-unipi/background-tasks/src/registry.js");
    const registry = new BackgroundTaskRegistry({ sendCompletionNotification: () => {} });
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "detach-watchdog" } } as never;
    let adoptedTaskId: string | undefined;
    setBashBackgroundAdopter(async (request) => {
      const task = await registry.adoptRunningProcess(ctx, request.child, {
        command: request.command, startTime: request.startTime, stop: request.stop, initialOutput: request.initialOutput,
        notifyOnCompletion: true, triggerOnCompletion: true, watchdogAdopted: true,
      });
      adoptedTaskId = task.id;
      return { taskId: task.id, outputPath: task.outputPath };
    });

    const abort = new AbortController();
    const done = bashDefinition().execute("call-bg", { command: "printf a; sleep 30; printf b" }, abort.signal, undefined, undefined as never);
    await new Promise((r) => setTimeout(r, 150));

    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-bg", toolName: "bash", args: { command: "printf a; sleep 30; printf b" } },
      fakeCtx(),
    );
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());

    watchdogMod.__setClock(() => 2_030_000);
    await tickFn(fakeCtx());
    assert.ok(states[1]!.includes("Process tree (sampled over 5s):"));
    assert.ok(!states[1]!.includes("Output changed"));
    assert.ok(states[2]!.includes("Output changed since previous check (0s): no"));
    console.log("TICK STATE:\n" + states[2]);
    assert.ok(adoptedTaskId, "the registry adopted the running process");
    assert.ok(!watchdogMod.__getKills().has("call-bg"), "no kill recorded for a successfully backgrounded call");

    // tool_result for this id must NOT get the kill-prefix rewrite.
    const result = await handlers["tool_result"]!({
      type: "tool_result", toolCallId: "call-bg", toolName: "bash",
      input: {}, content: [{ type: "text", text: "a" }], isError: false,
    }) as undefined;
    assert.equal(result, undefined, "no kill-prefix annotation for a detached call");

    abort.abort();
    const detachedResult = await done;
    assert.equal(detachedResult.isError, false);
    assert.match(JSON.stringify(detachedResult.content), /jev judged it unlikely to finish on its own/);
    await registry.stopTask(registry.resolveTask(adoptedTaskId!), "user").catch(() => {});
  });

  it("action: background — no adopter registered: falls back to kill", async () => {
    await enableJudge({ action: "background", firstCheckMin: 0, intervalMin: 0.5 });
    stubJev("looping");
    process.env.UNIPI_WATCHDOG_FORCE_ACT = "1";
    watchdogMod.__setClock(() => 3_000_000);
    setBashBackgroundAdopter(null); // explicitly unavailable

    const cmd = "sleep 300; echo wd-fallback-unique";
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((r) => setTimeout(r, 150));

    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-fallback", toolName: "bash", args: { command: cmd } },
      fakeCtx(),
    );
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());

    assert.ok(watchdogMod.__getKills().has("call-fallback"), "unavailable background adopter falls back to killing the bash child");

    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    if (alive) child.kill("SIGKILL");
    assert.equal(alive, false, "the child process group was actually killed on fallback");
  });

  it("watchdog-adopted background tasks are never judged again", async () => {
    await enableJudge({ action: "background", firstCheckMin: 0 });
    let judged = 0;
    globalThis.fetch = async () => { judged++; throw new Error("must not judge adopted tasks"); };
    watchdogMod.setRegistryTasks([{ id: "adopted", command: "sleep 300", status: "running", startTime: 0,
      notifyOnCompletion: true, triggerOnCompletion: true, watchdogAdopted: true }]);
    watchdogMod.__setClock(() => 3_000_000);
    await watchdogMod.__watchdogTick(fakeCtx() as never);
    assert.equal(judged, 0);
  });

  it("/unipi:bg-detach: success and failure notify the user", async () => {
    const notesOk: Array<{ text: string; level: string }> = [];
    const notesFail: Array<{ text: string; level: string }> = [];
    assert.ok(commands["unipi:bg-detach"], "command registered");

    setBashBackgroundAdopter(null);
    await commands["unipi:bg-detach"]!.handler("", fakeCtx(notesFail));
    assert.ok(notesFail.some((n) => n.level === "warning"), "no running bash call / no adopter → warning");

    const { BackgroundTaskRegistry } = await import("@pi-unipi/background-tasks/src/registry.js");
    const registry = new BackgroundTaskRegistry({ sendCompletionNotification: () => {} });
    const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => "manual-detach" } } as never;
    let taskId: string | undefined;
    setBashBackgroundAdopter(async (request) => {
      const task = await registry.adoptRunningProcess(ctx, request.child, {
        command: request.command, startTime: request.startTime, stop: request.stop, initialOutput: request.initialOutput,
        notifyOnCompletion: true, triggerOnCompletion: true, watchdogAdopted: true,
      });
      taskId = task.id;
      return { taskId: task.id, outputPath: task.outputPath };
    });
    const abort = new AbortController();
    const done = bashDefinition().execute("manual", { command: "printf a; sleep 2; printf b" }, abort.signal, undefined, undefined as never);
    await new Promise((r) => setTimeout(r, 150));

    await commands["unipi:bg-detach"]!.handler("manual test", fakeCtx(notesOk));
    assert.ok(notesOk.some((n) => n.level === "info" && taskId && n.text.includes(taskId)), "success notifies with the task id");

    abort.abort();
    await registry.stopTask(registry.resolveTask(taskId!), "user").catch(() => {});
    await done.catch(() => {});
  });
});
