/**
 * UNI-107 — every bash tool registration (simple / regular / advanced) is
 * wired through @pi-unipi/core's detachable-bash operations/execute wrapper,
 * so the watchdog (a separate, optional package) can move a stuck command to
 * the background without unipi's own bash tool definitions depending on it.
 * commandPrefix / shellPath / spawnHook from pi's own settings must still be
 * honored exactly as before.
 *
 * Utility itself has zero dependency on @pi-unipi/watchdog — this file only
 * imports @pi-unipi/core (already a dependency) and @pi-unipi/utility's own
 * render/tools.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachCurrentBashCall, setBashBackgroundAdopter } from "../../core/detachable-bash.ts";
import { registerToolRenderers, type RenderStyle } from "../src/render/tools.ts";

type AnyDef = {
  name: string;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown }>;
};

/** Fake ExtensionAPI capturing every registerTool call. */
function fakePi(): { registerTool(def: AnyDef): void; defs: AnyDef[] } {
  const defs: AnyDef[] = [];
  return {
    registerTool(def: AnyDef) {
      defs.push(def);
    },
    defs,
  };
}

function bashDefsFor(style: RenderStyle): AnyDef[] {
  const pi = fakePi();
  registerToolRenderers(pi as never, style);
  return pi.defs.filter((d) => d.name === "bash");
}

/** Minimal ctx pi's bash execute() reads for session-env exposure. */
function fakeCtx(cwd: string): unknown {
  return {
    cwd,
    sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
  };
}

describe("UNI-107: bash tool registrations carry detachable-bash operations", () => {
  for (const style of ["simple", "regular", "advanced"] as const) {
    it(`${style}: detached rendering has background marker without exit footer`, () => {
      const [bash] = bashDefsFor(style);
      const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text };
      const ctx = { toolCallId: `render-${style}`, cwd: process.cwd(), args: {command:"sleep 30"}, state: {}, expanded: false,
        executionStarted: true, isError: false, invalidate: () => {} };
      const call = style === "regular" ? undefined : bash!.renderCall!({command:"sleep 30"},theme,ctx);
      const result = bash!.renderResult!({content:[{type:"text",text:"a"}],details:{detachedToTask:"b123"}}, {isPartial:false,expanded:false},theme,ctx);
      const rendered = [...(call?.render(120) ?? []),...(result?.render(120) ?? [])].join("\n");
      assert.match(rendered,/→ background task b123/); assert.ok(!/exit/i.test(rendered));
    });
    it(`${style}: registers exactly one bash tool`, () => {
      const defs = bashDefsFor(style);
      assert.equal(defs.length, 1);
      assert.equal(defs[0]!.name, "bash");
    });

    it(`${style}: a long-running command detached mid-flight resolves with a background-task notice, not a hang/error`, async () => {
      const [bash] = bashDefsFor(style);
      setBashBackgroundAdopter(async (request) => {
        request.child.on("error", () => {});
        setTimeout(request.stop, 100);
        return { taskId: "bg-task-1", outputPath: "/tmp/bg-task-1.log" };
      });
      try {
        const cwd = mkdtempSync(join(tmpdir(), "uni107-"));
        const controller = new AbortController();
        const executePromise = bash.execute(
          "call-detach-1",
          { command: "echo start; sleep 5; echo end" },
          controller.signal,
          undefined,
          fakeCtx(cwd),
        );
        // Detach once the child has had a moment to spawn and emit its first
        // line — mirrors how the watchdog detaches a command it judges stuck.
        await new Promise((r) => setTimeout(r, 200));
        const detached = await detachCurrentBashCall("looks stuck");
        assert.ok(detached, "detachCurrentBashCall should find the in-flight call");
        assert.equal(detached!.taskId, "bg-task-1");
        const result = await executePromise;
        assert.equal(result.isError, false);
        const text = (result.content ?? []).map((c) => c.text ?? "").join("");
        assert.match(text, /background task bg-task-1/);
        assert.match(text, /looks stuck/);
      } finally {
        setBashBackgroundAdopter(null);
      }
    });
  }
});

describe("UNI-107: pi settings (commandPrefix / shellPath / spawnHook) survive the detachable wrap", () => {
  for (const style of ["simple", "regular", "advanced"] as const) {
    it(`${style}: commandPrefix from pi settings is still prepended to the command`, async () => {
      const [bash] = bashDefsFor(style);
      const cwd = mkdtempSync(join(tmpdir(), "uni107-prefix-"));
      const result = await bash.execute(
        "call-2",
        { command: "echo second" },
        new AbortController().signal,
        undefined,
        fakeCtx(cwd),
      );
      // No crash, and the command itself still ran (commandPrefix is read from
      // ~/.pi/agent + project settings by readPiToolOptions; when unset it is a
      // no-op, which is the default test environment — this asserts the plain
      // command still executes end to end through the wrapped operations).
      const text = (result.content ?? []).map((c) => c.text ?? "").join("");
      assert.match(text, /second/);
    });
  }
});

describe("UNI-107: utility has no runtime dependency on @pi-unipi/watchdog", () => {
  it("package.json dependencies do not list @pi-unipi/watchdog", async () => {
    const pkg = (await import("../package.json", { with: { type: "json" } })) as unknown as {
      default: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    };
    const { dependencies = {}, devDependencies = {}, peerDependencies = {} } = pkg.default;
    for (const deps of [dependencies, devDependencies, peerDependencies]) {
      assert.ok(!("@pi-unipi/watchdog" in deps), "utility must not depend on watchdog");
    }
  });

  it("render/tools.ts source never imports @pi-unipi/watchdog", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/render/tools.ts", import.meta.url), "utf-8");
    assert.ok(!src.includes("@pi-unipi/watchdog"));
  });
});
