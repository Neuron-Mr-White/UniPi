import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSharedFusionStatus } from "@pi-unipi/core";
import fusionExtension from "../src/index.js";
import { EDIT_NUDGE, bashNudge } from "../src/prompts.js";
import { globalPresetPath, loadPreset } from "../src/preset.js";

function model(provider: string, id: string): Record<string, unknown> {
  return { provider, id, name: id, reasoning: true, cost: { input: 1, cacheRead: 0.1, output: 2 } };
}

function setup(home: string, cwd: string, models: Record<string, unknown>[]) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const calls = { setModel: [] as Record<string, unknown>[], thinking: [] as string[], notices: [] as string[], entryRenderers: new Map<string, (entry: { data?: unknown }, options: { expanded?: boolean }, theme: unknown) => unknown>() };
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    registerTool: () => undefined,
    getActiveTools: () => ["read", "bash", "sidekick", "read_subagent"],
    setActiveTools: () => undefined,
    registerCommand: () => undefined,
    registerMessageRenderer: () => undefined,
    registerEntryRenderer: (type: string, renderer: (entry: { data?: unknown }, options: { expanded?: boolean }, theme: unknown) => unknown) => {
      calls.entryRenderers.set(type, renderer);
    },
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

test("bash nudge fires once per handoff gap; only a completed handoff re-arms it", async () => {
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
    // Latched: further non-trivial calls never nudge again in this gap.
    for (let i = 0; i < 8; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    // A new prompt restarts the streak but NOT the latch — no re-nudge.
    handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} } }, ctx);
    for (let i = 0; i < 6; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined, "a new prompt alone must not re-arm the nudge");
    // A completed sidekick handoff re-arms: the 4th non-trivial call nudges again.
    toolResult({ toolName: "sidekick", content: [] }, ctx);
    for (let i = 0; i < 3; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    const again = toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(again?.content.at(-1)?.text, bashNudge(4));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("a new prompt restarts the streak but not the latch; trivial commands never count", async () => {
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
    // First run: 12 non-trivial bash results → exactly one nudge (the 4th).
    for (let i = 0; i < 3; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    const first = toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(first?.content.at(-1)?.text, bashNudge(4));
    for (let i = 0; i < 8; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    // Trivial commands still don't count toward the streak.
    for (let i = 0; i < 5; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "git status" }, content: [] }, ctx), undefined);
    // New prompt: the streak restarts from zero but the nudge stays latched.
    handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} } }, ctx);
    for (let i = 0; i < 6; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined, "latched nudge must stay silent across prompts");
    // A completed handoff is the only re-arm.
    toolResult({ toolName: "read_subagent", content: [] }, ctx);
    for (let i = 0; i < 3; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    const second = toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(second?.content.at(-1)?.text, bashNudge(4));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("a new prompt restarts the streak; a carried-over count cannot nudge early", async () => {
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
    // Run 1 accumulates 3 non-trivial calls but never reaches the nudge.
    for (let i = 0; i < 3; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    // A new prompt resets the streak, so the fresh run starts from zero.
    handlers.get("before_agent_start")?.({ systemPromptOptions: { sections: {} } }, ctx);
    assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined, "no nudge on the first non-trivial call of a fresh prompt");
    // The once-per-run guarantee still holds within the same run.
    for (let i = 0; i < 2; i++) assert.equal(toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx), undefined);
    const fourth = toolResult({ toolName: "bash", input: { command: "npm test" }, content: [] }, ctx) as { content: Array<{ text?: string }> } | undefined;
    assert.equal(fourth?.content.at(-1)?.text, bashNudge(4));
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

test("persisted sidekick-step renderer reads stored groups", () => {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "uni-fusion-index-"));
  const previousCwd = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "uni-fusion-cwd-"));
  process.env.HOME = home;
  process.chdir(cwd);
  try {
    const { calls } = setup(home, process.cwd(), [{ provider: "a", id: "lead", name: "lead", reasoning: true, cost: { input: 1, cacheRead: 0.1, output: 2 } }]);
    const renderer = calls.entryRenderers.get("sidekick-step");
    assert.ok(renderer, "sidekick-step entry renderer registered");
    const strip = (s: string) => String(s).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const renderGroup = (data: Record<string, unknown>) => {
      const comp = renderer!({ data }, { expanded: false }, { fg: (c: string, t: string) => t, bold: (t: string) => t }) as { spacingGroup: string; render(w: number): string[] };
      return { group: comp.spacingGroup, first: strip(comp.render(80)[0]!) };
    };
    assert.equal(
      renderGroup({ kind: "tool", name: "read", arg: "a.ts", output: "", isError: false, durationMs: 5, group: "sidekick:h1", label: "Sidekick" }).group,
      "sidekick:h1",
      "persisted group passes through",
    );
    assert.equal(
      renderGroup({ kind: "tool", name: "read", arg: "a.ts", output: "", isError: false, durationMs: 5 }).group,
      "sidekick",
      "old entries fall back to the shared group",
    );
    assert.equal(
      renderGroup({ kind: "tool", name: "read", arg: "a.ts", output: "", isError: false, durationMs: 5, group: "sidekick:h1", label: "Sidekick" }).first,
      "▏ ◆ Sidekick",
      "persisted label draws the panel header once",
    );
    const noLabel = renderGroup({ kind: "tool", name: "read", arg: "a.ts", output: "", isError: false, durationMs: 5 });
    assert.equal(noLabel.group, "sidekick");
    assert.ok(noLabel.first.startsWith("▏ ") && !noLabel.first.includes("Sidekick"), "old entries without label start straight at the tree");
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
