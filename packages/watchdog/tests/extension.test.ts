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
  let watchdogMod: {
    registerWatchdogExtension: (pi: any) => void;
    __recordKill: (id: string, r: { durationMs: number; reason: string }) => void;
    resetWatchdogState: () => void;
    __watchdogTick: (ctx: unknown) => Promise<void>;
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
    watchdogMod = (await import("../index.js")) as typeof watchdogMod;
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
});
