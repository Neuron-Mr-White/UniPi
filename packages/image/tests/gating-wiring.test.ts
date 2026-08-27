/**
 * Wiring smoke test: drive the extension's session_start / model_select
 * handlers against a fake pi and verify image_recognize visibility follows
 * the session model's vision capability.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import registerImageExtension from "../src/index.ts";

const RECOGNIZE = "image_recognize";
const GENERATE = "image_generate";

/** Minimal fake of pi's ExtensionAPI surface the extension touches. */
function fakePi() {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
  let activeTools: string[] = [];
  const emitted: unknown[] = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      (handlers[event] ??= []).push(handler);
    },
    registerTool(tool: { name: string }) {
      if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
    },
    registerCommand() {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    emit() {},
  };
  return {
    pi,
    handlers,
    emitted,
    getActive: () => [...activeTools],
    async fire(event: string, payload: unknown = {}, ctx: unknown = {}) {
      for (const handler of handlers[event] ?? []) await handler(payload, ctx);
    },
  };
}

describe("vision gating wiring", () => {
  it("hides image_recognize at session_start for a vision model", async () => {
    const t = fakePi();
    registerImageExtension(t.pi as never);
    await t.fire("session_start", {}, {
      model: { id: "claude-sonnet-4-6", provider: "anthropic", input: ["text", "image"] },
    });
    assert.ok(!t.getActive().includes(RECOGNIZE), "tool must be hidden for vision model");
    assert.ok(t.getActive().includes(GENERATE), "image_generate must stay");
  });

  it("keeps image_recognize for a text-only model", async () => {
    const t = fakePi();
    registerImageExtension(t.pi as never);
    await t.fire("session_start", {}, {
      model: { id: "deepseek-r1", provider: "openrouter", input: ["text"] },
    });
    assert.ok(t.getActive().includes(RECOGNIZE));
  });

  it("toggles on model_select when the model changes mid-session", async () => {
    const t = fakePi();
    registerImageExtension(t.pi as never);
    await t.fire("session_start", {}, {
      model: { id: "deepseek-r1", provider: "openrouter", input: ["text"] },
    });
    assert.ok(t.getActive().includes(RECOGNIZE), "provided initially");

    await t.fire("model_select", {
      model: { id: "claude-sonnet-4-6", provider: "anthropic", input: ["text", "image"] },
    });
    assert.ok(!t.getActive().includes(RECOGNIZE), "hidden after switching to vision");

    await t.fire("model_select", {
      model: { id: "deepseek-r1", provider: "openrouter", input: ["text"] },
    });
    assert.ok(t.getActive().includes(RECOGNIZE), "restored after switching back");
  });
});
