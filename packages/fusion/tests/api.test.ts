/**
 * @pi-unipi/fusion — UI-free API (UNI-160): getPicker()/apply() against a
 * fake pi, same fixture shape as index.test.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetBusForTests } from "@pi-unipi/core";
import { getFusionApi, clearFusionApiForTests } from "../src/api.js";
import fusionExtension from "../src/index.js";

function model(provider: string, id: string): Record<string, unknown> {
  return { provider, id, name: id, reasoning: true, cost: { input: 1, cacheRead: 0.1, output: 2 } };
}

function setup(models: Record<string, unknown>[]) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const notices: string[] = [];
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    registerTool: () => undefined,
    getActiveTools: () => ["read", "bash"],
    setActiveTools: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerEntryRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    getThinkingLevel: () => "medium",
  };
  const previousChild = process.env.UNIPI_FUSION_CHILD;
  delete process.env.UNIPI_FUSION_CHILD;
  try {
    fusionExtension(pi as never);
  } finally {
    if (previousChild === undefined) delete process.env.UNIPI_FUSION_CHILD;
    else process.env.UNIPI_FUSION_CHILD = previousChild;
  }
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    model: undefined,
    modelRegistry: { getAvailable: () => models, find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) },
    ui: { notify: (message: string) => notices.push(message), addAutocompleteProvider: () => undefined },
  };
  return { handlers, notices, ctx };
}

describe("fusion UI-free API (UNI-160)", () => {
  let home: string;
  let cwd: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    resetBusForTests();
    clearFusionApiForTests();
    home = mkdtempSync(join(tmpdir(), "fusion-api-home-"));
    cwd = mkdtempSync(join(tmpdir(), "fusion-api-cwd-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("getPicker() is undefined before any session_start", () => {
    setup([]);
    assert.equal(getFusionApi()?.getPicker(), undefined);
  });

  it("getPicker() reflects the preset once a session starts", async () => {
    const lead = model("p", "lead-1");
    const side = model("p", "side-1");
    const { handlers, ctx } = setup([lead, side]);
    await handlers.get("session_start")?.({ reason: "startup" }, { ...ctx, cwd });
    const picker = getFusionApi()!.getPicker();
    assert.ok(picker);
    assert.deepEqual(picker!.leads, []);
    assert.deepEqual(picker!.sidekicks, []);
    assert.equal(picker!.active, undefined);
  });

  it("apply() switches the model and returns ok without any ctx.ui.notify", async () => {
    const lead = model("p", "lead-1");
    const { handlers, ctx, notices } = setup([lead]);
    await handlers.get("session_start")?.({ reason: "startup" }, { ...ctx, cwd });
    const api = getFusionApi()!;
    const result = await api.apply({ type: "single", model: "p/lead-1", effort: "high", effortMap: {} });
    assert.deepEqual(result, { ok: true });
    assert.equal(notices.length, 0, "apply() must stay UI-free: no ctx.ui.notify");
  });

  it("apply() with an unknown model returns ok:false and a message, never throws", async () => {
    const { handlers, ctx } = setup([]);
    await handlers.get("session_start")?.({ reason: "startup" }, { ...ctx, cwd });
    const api = getFusionApi()!;
    const result = await api.apply({ type: "single", model: "nope/nope", effort: "medium", effortMap: {} });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /not available/);
  });
});
