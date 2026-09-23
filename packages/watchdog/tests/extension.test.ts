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

  it("agreeChecks 2: first tick no kill, second tick kills", async () => {
    const { setSettings } = await import("@pi-unipi/core");
    setSettings("watchdog", { enabled: true, agreeChecks: 2, confidence: 0.8, watchBash: true, intervalMin: 0.1, firstCheckMin: 0 }, "global", process.cwd());
    // start a bash tool call
    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-wd", toolName: "bash", args: { command: "while true; do echo err; done" } },
      fakeCtx(),
    );
    (globalThis as { fetch: unknown }).fetch = async (url: unknown, init: { body: string }) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        answers: {
          status: { choice: "looping", confidence: 0.95 },
          persistent: { noul: 0.0 },
        },
      }), { status: 200 });
    };
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;

    // tick 1: streak 1, no kill
    await tickFn(fakeCtx());
    assert.equal(fetchCalls.length, 1, "one jev call");
    assert.ok(!handlers["tool_result"], "no tool_result override on streak 1");

    // tick 2: streak 2, act = true
    await tickFn(fakeCtx());
    assert.equal(fetchCalls.length, 2, "two jev calls");
    assert.ok(watchdogMod.__getKills().has("call-wd"), "kill recorded on streak 2");
  });

  it("never checked twice within intervalMin", async () => {
    const { setSettings } = await import("@pi-unipi/core");
    setSettings("watchdog", { enabled: true, agreeChecks: 1, confidence: 0.8, watchBash: true, intervalMin: 0.5, firstCheckMin: 0 }, "global", process.cwd());
    handlers["tool_execution_start"]!(
      { type: "tool_execution_start", toolCallId: "call-x", toolName: "bash", args: { command: "sleep 300" } },
      fakeCtx(),
    );
    (globalThis as { fetch: unknown }).fetch = async () =>
      new Response(JSON.stringify({ answers: { status: { choice: "stuck", confidence: 0.95 }, persistent: { noul: 0.0 } } }), { status: 200 });
    const tickFn = handlers["__watchdog_tick"] as (ctx: unknown) => Promise<void>;
    await tickFn(fakeCtx());
    const afterFirst = fetchCalls.length;
    assert.ok(afterFirst > 0, "first tick jev calls made");
    await tickFn(fakeCtx()); // immediate second tick → per-item gate skips
    assert.equal(fetchCalls.length, afterFirst, "no new jev calls within intervalMin");
  });
});
