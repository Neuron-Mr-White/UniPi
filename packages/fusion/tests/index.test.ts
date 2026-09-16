import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSharedFusionStatus } from "@pi-unipi/core";
import fusionExtension from "../src/index.js";
import { EDIT_NUDGE, bashNudge } from "../src/prompts.js";
import { globalPresetPath, loadPreset } from "../src/preset.js";

function model(provider: string, id: string): Record<string, unknown> {
  return { provider, id, name: id, reasoning: true, cost: { input: 1, cacheRead: 0.1, output: 2 } };
}

function setup(home: string, cwd: string, models: Record<string, unknown>[]) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const calls = { setModel: [] as Record<string, unknown>[], thinking: [] as string[], notices: [] as string[] };
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    setModel: async (value: Record<string, unknown>) => {
      calls.setModel.push(value);
      return true;
    },
    setThinkingLevel: (value: string) => calls.thinking.push(value),
    getThinkingLevel: () => "medium",
  };
  // A Fusion sidekick child (UNIPI_FUSION_CHILD=1) makes the extension a
  // deliberate no-op, so the harness must not inherit that ambient env.
  const previousChild = process.env.UNIPI_FUSION_CHILD;
  delete process.env.UNIPI_FUSION_CHILD;
  try {
    fusionExtension(pi as never);
  } finally {
    if (previousChild === undefined) delete process.env.UNIPI_FUSION_CHILD;
    else process.env.UNIPI_FUSION_CHILD = previousChild;
  }
  const ctx = {
    cwd,
    hasUI: true,
    model: models[models.length - 1],
    modelRegistry: { getAvailable: () => models },
    ui: {
      notify: (message: string) => calls.notices.push(message),
      addAutocompleteProvider: () => undefined,
    },
  };
  return { handlers, calls, ctx, home };
}

function writePreset(home: string, active: Record<string, unknown>): void {
  const path = globalPresetPath(home);
  mkdirSync(join(home, ".unipi", "config", "fusion"), { recursive: true });
  writeFileSync(path, JSON.stringify({ lead: ["a/lead"], sidekick: ["b/side"], active }));
}

test("session_start restores a persisted Fusion lead when pi boots on sidekick", async () => {
  const home = mkdtempSync(join("/tmp", "fusion-index-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-index-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writePreset(home, { kind: "fusion", lead: "a/lead", sidekick: "b/side", leadEffort: "high", sidekickEffort: "low" });
    const lead = model("a", "lead");
    const side = model("b", "side");
    const { handlers, calls, ctx } = setup(home, cwd, [lead, side]);
    await handlers.get("session_start")?.({}, ctx);
    assert.deepEqual(calls.setModel, [lead]);
    assert.deepEqual(calls.thinking, ["high"]);
    assert.equal(getSharedFusionStatus()?.leadName, "lead");
    assert.equal(getSharedFusionStatus()?.sidekickName, "side");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("session_start disables Fusion and warns when the persisted lead is unavailable", async () => {
  const home = mkdtempSync(join("/tmp", "fusion-index-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-index-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writePreset(home, { kind: "fusion", lead: "a/lead", sidekick: "b/side" });
    const { handlers, calls, ctx } = setup(home, cwd, [model("b", "side")]);
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(calls.setModel.length, 0);
    assert.deepEqual(calls.notices, ["Fusion lead a/lead unavailable — Fusion off"]);
    assert.equal(getSharedFusionStatus(), undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("model_select persists leaving Fusion as a single-model selection", async () => {
  const home = mkdtempSync(join("/tmp", "fusion-index-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-index-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writePreset(home, { kind: "fusion", lead: "a/lead", sidekick: "b/side" });
    const lead = model("a", "lead");
    const side = model("b", "side");
    const other = model("c", "other");
    const { handlers, ctx } = setup(home, cwd, [lead, side, other]);
    await handlers.get("session_start")?.({}, { ...ctx, model: lead });
    handlers.get("model_select")?.({ model: other }, { ...ctx, model: other });
    const saved = JSON.parse(readFileSync(globalPresetPath(home), "utf8")) as { active?: { kind?: string; model?: string } };
    assert.deepEqual(saved.active, { kind: "single", model: "c/other" });
    assert.deepEqual(loadPreset(cwd, home).preset.active, { kind: "single", model: "c/other" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("recurring edit nudges reset once per turn", async () => {
  const home = mkdtempSync(join("/tmp", "fusion-index-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-index-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writePreset(home, { kind: "fusion", lead: "a/lead", sidekick: "b/side" });
    const lead = model("a", "lead");
    const side = model("b", "side");
    const { handlers, ctx } = setup(home, cwd, [lead, side]);
    await handlers.get("session_start")?.({}, { ...ctx, model: lead });
    const toolResult = handlers.get("tool_result")!;
    const first = toolResult({ toolName: "edit", content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(first?.content.at(-1)?.text, EDIT_NUDGE);
    assert.equal(toolResult({ toolName: "edit", content: [] }, ctx), undefined);
    handlers.get("turn_start")?.({}, ctx);
    const nextTurn = toolResult({ toolName: "edit", content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(nextTurn?.content.at(-1)?.text, EDIT_NUDGE);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("bash nudges recur every four non-trivial commands and sidekick resets", async () => {
  const home = mkdtempSync(join("/tmp", "fusion-index-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-index-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writePreset(home, { kind: "fusion", lead: "a/lead", sidekick: "b/side" });
    const lead = model("a", "lead");
    const side = model("b", "side");
    const { handlers, ctx } = setup(home, cwd, [lead, side]);
    await handlers.get("session_start")?.({}, { ...ctx, model: lead });
    const toolResult = handlers.get("tool_result")!;
    for (let i = 0; i < 3; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    const fourth = toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(fourth?.content.at(-1)?.text, bashNudge(4));
    toolResult({ toolName: "sidekick", content: [] }, ctx);
    for (let i = 0; i < 3; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("trivial bash does not contribute to the nudge streak or lead status count", async () => {
  const home = mkdtempSync(join("/tmp", "fusion-index-home-"));
  const cwd = mkdtempSync(join("/tmp", "fusion-index-cwd-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writePreset(home, { kind: "fusion", lead: "a/lead", sidekick: "b/side" });
    const lead = model("a", "lead");
    const side = model("b", "side");
    const { handlers, ctx } = setup(home, cwd, [lead, side]);
    await handlers.get("session_start")?.({}, { ...ctx, model: lead });
    const toolResult = handlers.get("tool_result")!;
    toolResult({ toolName: "bash", input: { command: "git status" }, content: [] }, ctx);
    const status = getSharedFusionStatus();
    assert.equal(status?.busy, false);
    assert.equal(status?.leadToolCalls, 1);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
