// UNI-48 wiring: the extension actually registers the subagent-step entry
// renderer and, for foreground AND background runs, pipes manager.start's
// onStep into pi.appendEntry. Uses the injectable manager (fake runtime that
// settles) and a scratch HOME — no real child, no real state.
import { strict as assert } from "node:assert";
import { test, after } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagents, { appendSubagentStep } from "../index.js";
import { SubagentManager, type SubagentRecord } from "../manager.js";
import type { SidekickStep } from "@pi-unipi/core/child-agent.js";

const scratch = mkdtempSync(join(tmpdir(), "uni-subagent-wiring-"));
const prevEnv: Array<[string, string | undefined]> = [
  ["HOME", process.env.HOME],
  ["PI_CODING_AGENT_DIR", process.env.PI_CODING_AGENT_DIR],
];
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
after(() => {
  for (const [name, value] of prevEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const step: SidekickStep = { kind: "tool", name: "read", arg: "a.ts", output: "x", isError: false, durationMs: 4, args: { path: "a.ts" } };
const done = Promise.resolve({ id: "h", status: "completed" as const, text: "demo", usage: {}, toolCalls: 1, durationMs: 5, events: [] });

function fakePi() {
  const tools = new Map<string, { execute: (...a: unknown[]) => unknown }>();
  const entryRenderers = new Map<string, (entry: { data?: unknown }, opts: { expanded?: boolean }, theme: unknown) => unknown>();
  const appended: Array<{ type: string; data: Record<string, unknown> }> = [];
  const noop = () => undefined;
  const pi = {
    on: noop,
    registerTool: (def: { name: string; execute: (...a: unknown[]) => unknown }) => tools.set(def.name, def),
    registerCommand: noop,
    registerMessageRenderer: noop,
    registerEntryRenderer: (type: string, renderer: (entry: { data?: unknown }, opts: { expanded?: boolean }, theme: unknown) => unknown) => entryRenderers.set(type, renderer),
    registerShortcut: noop,
    registerFlag: noop,
    sendMessage: noop,
    getActiveTools: () => [] as string[],
    setActiveTools: noop,
    appendEntry: (type: string, data: Record<string, unknown>) => appended.push({ type, data }),
  };
  return { pi, tools, entryRenderers, appended };
}

const wiredManager = () =>
  new SubagentManager((opts) => {
    (opts as { onStep?: (s: SidekickStep) => void }).onStep?.(step);
    return {
      progress: () => ({ toolCalls: 0 }),
      handoff: () => ({ id: "h", done }),
      kill: () => undefined,
      detachUi: () => undefined,
      attachUi: () => undefined,
    } as never;
  });

const ctx = { cwd: join(scratch, "ctx"), hasPendingMessages: () => false };

test("extension registers the subagent-step delegated renderer", () => {
  const { pi, entryRenderers } = fakePi();
  subagents(pi as never, { manager: wiredManager() });
  const renderer = entryRenderers.get("subagent-step");
  assert.ok(renderer, "subagent-step entry renderer registered");
  const comp = renderer({ data: { kind: "tool", name: "read", arg: "a.ts", output: "", isError: false, durationMs: 1, group: "subagent:a:1", label: "Explore subagent · demo" } }, { expanded: false }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }) as { spacingGroup: string };
  assert.equal(comp.spacingGroup, "subagent:a:1", "renderer produces a delegated panel with the stored group");
});

test("background run streams steps via pi.appendEntry", async () => {
  const { pi, tools, appended } = fakePi();
  subagents(pi as never, { manager: wiredManager() });
  const execute = tools.get("run_subagent")!.execute as (...a: unknown[]) => Promise<unknown>;
  const result = await execute("t1", { title: "demo", task: "x", profile: "subagent_explore", is_background: true }, undefined, undefined, ctx);
  assert.ok(result, "bg start returns a result");
  const stepEntries = appended.filter((e) => e.type === "subagent-step");
  assert.ok(stepEntries.length >= 1, "completed step appended in background");
  assert.match(String(stepEntries[0]!.data.group), /^subagent:[0-9a-f]+:\d+$/, "group unique per agent run");
  await new Promise((r) => setTimeout(r, 0));
});

test("foreground run streams steps via pi.appendEntry and returns the report", async () => {
  const { pi, tools, appended } = fakePi();
  subagents(pi as never, { manager: wiredManager() });
  const execute = tools.get("run_subagent")!.execute as (...a: unknown[]) => Promise<unknown>;
  const result = await execute("t2", { title: "demo-fg", task: "x", profile: "subagent_explore" }, undefined, undefined, ctx) as { content?: Array<{ text?: string }> };
  const stepEntries = appended.filter((e) => e.type === "subagent-step");
  assert.ok(stepEntries.length >= 1, "completed step appended in foreground");
  const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
  assert.match(text, /demo/, "final report still comes back as the tool result (not duplicated as a step)");
  assert.ok(!stepEntries.some((e) => e.data.kind === "text" && String(e.data.text ?? "").includes("demo")), "final report text is never streamed as a step");
  await new Promise((r) => setTimeout(r, 0));
});

test("appendSubagentStep is the exact payload the wired path emits", () => {
  const rec = { id: "a", title: "t", profile: "subagent_explore", startedAt: 7 } as SubagentRecord;
  const seen: Array<Record<string, unknown>> = [];
  appendSubagentStep((_t, data) => seen.push(data), rec, step);
  assert.equal(seen[0]!.group, "subagent:a:7");
});
