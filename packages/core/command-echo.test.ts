import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withCommandEcho, COMMAND_ECHO_TYPE } from "./command-echo.js";

function fakePi(overrides: Record<string, unknown> = {}) {
  const appended: Array<{ type: string; data: unknown }> = [];
  const commands = new Map<string, unknown>();
  const pi = {
    appendEntry: (customType: string, data?: unknown) => {
      appended.push({ type: customType, data });
    },
    registerCommand: (name: string, options: unknown) => {
      commands.set(name, options);
    },
    registerEntryRenderer: () => {},
    otherMethod: () => "passthrough-value",
    commands,
    appended,
    ...overrides,
  };
  return pi;
}

test("withCommandEcho wraps registerCommand, echoes name + trimmed args, calls original", async () => {
  const pi = fakePi();
  const api = withCommandEcho(pi as never);
  let called: { args: string; ctx: unknown } | null = null;
  api.registerCommand("unipi:btw", {
    handler: async (args: string, ctx: unknown) => {
      called = { args, ctx };
    },
  });
  const registered = pi.commands.get("unipi:btw") as { handler: (a: string, c: unknown) => Promise<void> };
  await registered.handler("  what codename  ", { fake: true });
  assert.deepEqual(called, { args: "  what codename  ", ctx: { fake: true } }, "original sees unmodified args/ctx");
  assert.deepEqual(pi.appended, [{ type: COMMAND_ECHO_TYPE, data: { text: "/unipi:btw what codename" } }]);
});

test("echo omits trailing space for empty args", async () => {
  const pi = fakePi();
  const api = withCommandEcho(pi as never);
  api.registerCommand("unipi:memory", { handler: async () => {} });
  await (pi.commands.get("unipi:memory") as any).handler("   ", {});
  assert.deepEqual(pi.appended[0].data, { text: "/unipi:memory" });
});

test("appendEntry failure never blocks the command", async () => {
  const pi = fakePi({
    appendEntry: () => {
      throw new Error("boom");
    },
  });
  const api = withCommandEcho(pi as never);
  let ran = false;
  api.registerCommand("unipi:status", {
    handler: async () => {
      ran = true;
    },
  });
  await (pi.commands.get("unipi:status") as any).handler("", {});
  assert.equal(ran, true);
});

test("non-registerCommand members pass through bound to the real pi", () => {
  const pi = fakePi();
  const api = withCommandEcho(pi as never) as unknown as { otherMethod(): string; appendEntry(): void };
  assert.equal(api.otherMethod(), "passthrough-value");
  api.appendEntry();
  assert.equal(pi.appended.length, 1, "appendEntry calls the real pi, not a copy");
});

// ── mid-run safety: a custom entry between a tool call and its result ───────

test("buildSessionContext skips custom entries between toolCall and toolResult", () => {
  const cwd = mkdtempSync(join(tmpdir(), "echo-ctx-"));
  try {
    const ts = new Date().toISOString();
    const header = { type: "session", version: 3, id: "s1", timestamp: ts, cwd };
    const entries = [
      header,
      { type: "message", id: "e1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } },
      {
        type: "message", id: "e2", parentId: "e1", timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }],
          api: "openai-responses", provider: "p", model: "m",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        },
      },
      { type: "custom", id: "e3", parentId: "e2", timestamp: ts, customType: COMMAND_ECHO_TYPE, data: { text: "/unipi:btw mid-run" }, display: true },
      {
        type: "message", id: "e4", parentId: "e3", timestamp: ts,
        message: { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: Date.now() },
      },
    ];
    const sm = SessionManager.inMemory(cwd, undefined, entries as never);
    const ctx = sm.buildSessionContext();
    const roles = ctx.messages.map((m) => (m as { role: string }).role);
    assert.deepEqual(roles, ["user", "assistant", "toolResult"], "echo entry skipped, tool pair intact");
    assert.ok(!JSON.stringify(ctx.messages).includes("/unipi:btw mid-run"));
    sm.dispose?.();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
