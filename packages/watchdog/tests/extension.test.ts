/**
 * Watchdog extension tests — tool_result rewrite, enabled=false gate,
 * and the process-group kill against a real detached child.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

describe("watchdog extension", () => {
  let home: string;
  let origHome: string | undefined;
  let handlers: Record<string, Handler>;
  let fetchCalls: Array<{ url: string; body: { state?: string; model?: string; questions?: Record<string, unknown> } }> = [];
  let watchdogMod: {
    registerWatchdogExtension: (pi: any) => void;
    __recordKill: (id: string, r: { durationMs: number; reason: string }) => void;
    resetWatchdogState: () => void;
    __watchdogTick: (ctx: unknown) => Promise<void>;
    __getKills: () => Map<string, unknown>;
    __setClock: (fn: (() => number) | null) => void;
    setRegistryTasks: (tasks: unknown[]) => void;
  };

  function fakePi(): unknown {
    handlers = {};
    return {
      on: (event: string, handler: Handler) => { handlers[event] = handler; },
      appendEntry: () => {},
    };
  }

  function fakeCtx(): unknown {
    return {
      hasUI: true, cwd: process.cwd(),
      ui: { setStatus: () => {}, notify: () => {} },
      sessionManager: { getSessionId: () => "s", getEntries: () => [] },
      abort: () => {}, sendUserMessage: () => {},
    };
  }

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "wd-test-"));
    origHome = process.env.HOME;
    process.env.HOME = home;
    fetchCalls = [];
    watchdogMod = (await import("../index.js")) as typeof watchdogMod;
    // registers the utility namespace (for the new gating tests)
    await import("@pi-unipi/utility/src/settings.js");
    watchdogMod.registerWatchdogExtension(fakePi());
  });

  afterEach(() => {
    watchdogMod.resetWatchdogState();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("tool_result rewrite: killed id gets ⚠ + isError; other ids untouched", async () => {
    watchdogMod.__recordKill("call-1", {
      durationMs: 95_000,
      reason: "stuck (confidence 0.92) on 2 consecutive checks — no new output for 95s",
    });
    assert.ok(handlers["tool_result"], "handler registered");

    const killed = await handlers["tool_result"]!({
      type: "tool_result", toolCallId: "call-1", toolName: "bash",
      input: {}, content: [{ type: "text", text: "some output" }], isError: false,
    }) as { content: Array<{ text: string }>; isError: boolean };
    assert.equal(killed.isError, true);
    assert.ok(killed.content[0]!.text.includes("⚠ Killed by unipi watchdog after 95s"));
    assert.ok(killed.content[0]!.text.includes("some output"));

    const other = await handlers["tool_result"]!({
      type: "tool_result", toolCallId: "call-2", toolName: "bash",
      input: {}, content: [{ type: "text", text: "files" }], isError: false,
    }) as { content: Array<{ text: string }>; isError: boolean } | undefined;
    assert.equal(other, undefined, "non-killed id untouched");
  });

  it("enabled=false → tick returns early, no jev call", async () => {
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = () => { calls++; return new Response("{}", { status: 200 }); };
    const sessionStart = handlers["session_start"]!;
    await sessionStart({ type: "session_start", reason: "startup" }, fakeCtx());
    await import("@pi-unipi/utility/src/settings.js"); // registers the utility namespace
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    assert.equal(calls, 0, "disabled → no jev call");
  });

  it("finds and kills a single detached bash child", async () => {
    const { findBashChildren, killProcessGroup } = await import("../src/bash-kill.js");
    const cmd = "sleep 300; echo wd-test-unique";
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((r) => setTimeout(r, 150));
    const candidates = findBashChildren(process.pid, cmd);
    const alive = candidates.pids.filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    assert.equal(alive.length, 1, "exactly one match");
    const pgid = candidates.pgids[candidates.pids.indexOf(alive[0]!)]!;
    const outcome = killProcessGroup(pgid, alive[0]!, alive.length);
    assert.equal(outcome.killed, true);
    await new Promise((r) => setTimeout(r, 300));
    try { process.kill(alive[0]!, 0); assert.fail("should be dead"); } catch { /* dead ✓ */ }
  });

  it("two identical commands → ambiguous, no kill", async () => {
    const { findBashChildren, killProcessGroup } = await import("../src/bash-kill.js");
    const cmd = "sleep 300; echo wd-test-ambiguous";
    const c1 = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    const c2 = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    c1.unref(); c2.unref();
    await new Promise((r) => setTimeout(r, 150));
    const candidates = findBashChildren(process.pid, cmd);
    assert.ok(candidates.pids.length >= 2, "both found");
    const outcome = killProcessGroup(candidates.pgids[0]!, candidates.pids[0]!, candidates.pids.length);
    assert.equal(outcome.killed, false, "ambiguous → no kill");
    c1.kill("SIGKILL"); c2.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
  });

  // ── fake-clock gating tests ───────────────────────────────────────────
  // Settings the gating tests share: jev reachable (stubbed fetch) through
  // the long-horizon Decision-model settings.
  async function enableJudge(watchdog: Record<string, unknown>): Promise<void> {
    const { setSettings } = await import("@pi-unipi/core");
    await import("@pi-unipi/long-horizon/src/settings.js");
    setSettings("long-horizon", { judge: { provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "test-key", baseUrl: "" } }, "global", process.cwd());
    setSettings("watchdog", { enabled: true, confidence: 0.8, watchBash: true, watchBgTasks: true, action: "kill", ...watchdog }, "global", process.cwd());
  }

  function stubJev(status: string, onCall?: (state: string) => void): { calls: () => number } {
    let calls = 0;
    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init: { body: string }) => {
      calls++;
      onCall?.(String((JSON.parse(String(init.body)) as { state?: string }).state ?? ""));
      return new Response(JSON.stringify({
        answers: { status: { choice: status, confidence: 0.95 }, persistent: { noul: 0.0 } },
      }), { status: 200 });
    };
    return { calls: () => calls };
  }

  it("firstCheckMin 0.5 / intervalMin 0.5 / agreeChecks 2: checked at ~30s and ~60s, killed at the 2nd check", async () => {
    await enableJudge({ agreeChecks: 2, intervalMin: 0.5, firstCheckMin: 0.5 });
    const jev = stubJev("looping");
    let now = 1_000_000;
    watchdogMod.__setClock(() => now);

    // A real detached child whose command the pid finder must match exactly once.
    const cmd = "sleep 300; echo wd-gating-unique";
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    await new Promise((r) => setTimeout(r, 150));

    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-gate", toolName: "bash", args: { command: cmd } },
      fakeCtx(),
    );
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;

    now += 15_000; // 15s: younger than firstCheckMin → not checked
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 0, "not checked before firstCheckMin");

    now += 15_000; // 30s: first check, streak 1/2 → no kill
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 1, "first check at ~30s");
    assert.ok(!watchdogMod.__getKills().has("call-gate"), "no kill on streak 1");

    now += 15_000; // 45s: within intervalMin of the last check → skipped
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 1, "not re-checked within intervalMin");

    now += 15_000; // 60s: second check, streak 2/2 → kill
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 2, "second check at ~60s");
    assert.ok(watchdogMod.__getKills().has("call-gate"), "killed at the 2nd agreeing check");

    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    if (alive) child.kill("SIGKILL");
    assert.equal(alive, false, "the child process group was actually killed");
  });

  it("never checked twice within intervalMin", async () => {
    await enableJudge({ agreeChecks: 5, intervalMin: 0.5, firstCheckMin: 0 });
    const jev = stubJev("stuck");
    let now = 2_000_000;
    watchdogMod.__setClock(() => now);
    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-x", toolName: "bash", args: { command: "sleep 300" } },
      fakeCtx(),
    );
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 1, "first tick checks");
    for (const step of [1_000, 5_000, 10_000]) {
      now += step; // cumulative 16s < 30s interval
      await tickFn(fakeCtx());
    }
    assert.equal(jev.calls(), 1, "no new jev calls within intervalMin");
    now += 14_000; // cumulative 30s → due again
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 2, "checked again once intervalMin elapsed");
  });

  it("bg sinceLastOutput grows while the tail is unchanged and resets on change", async () => {
    await enableJudge({ agreeChecks: 5, intervalMin: 0.5, firstCheckMin: 0 });
    const states: string[] = [];
    stubJev("progressing", (s) => states.push(s));
    let now = 3_000_000;
    watchdogMod.__setClock(() => now);
    const task = {
      id: "bg-1", command: "bash loop.sh", status: "running", startTime: now,
      notifyOnCompletion: true, triggerOnCompletion: true, outputTail: ["line a"],
    };
    watchdogMod.setRegistryTasks([task]);
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    const since = (s: string) => Number(/Since last new output: (\d+)s/.exec(s)?.[1]);

    await tickFn(fakeCtx());          // t=0: first sighting
    now += 30_000; await tickFn(fakeCtx()); // t=30: unchanged tail
    now += 30_000; await tickFn(fakeCtx()); // t=60: unchanged tail
    task.outputTail = ["line a", "line b"];
    now += 30_000; await tickFn(fakeCtx()); // t=90: changed tail

    assert.equal(states.length, 4);
    assert.equal(since(states[0]!), 0);
    assert.equal(since(states[1]!), 30, "grows while unchanged");
    assert.equal(since(states[2]!), 60, "keeps growing");
    assert.equal(since(states[3]!), 0, "resets when the tail changes");
    assert.ok(states[3]!.includes("Output changed since previous check: yes"));
  });

  it("bg task with triggerOnCompletion false (persistent service) is never checked", async () => {
    await enableJudge({ agreeChecks: 1, intervalMin: 0.5, firstCheckMin: 0 });
    const jev = stubJev("stuck");
    watchdogMod.setRegistryTasks([{
      id: "srv", command: "python3 -m http.server", status: "running", startTime: 0,
      notifyOnCompletion: true, triggerOnCompletion: false, outputTail: [],
    }]);
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    assert.equal(jev.calls(), 0);
  });
});
