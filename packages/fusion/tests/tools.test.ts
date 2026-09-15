import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFusionTools } from "../src/tools.js";
import type { HandoffReport, HandoffProgress } from "../src/sidekick-runtime.js";

const report: HandoffReport = {
  id: "h1",
  status: "completed",
  text: "implemented",
  usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, cost: 0.1 },
  toolCalls: 2,
  durationMs: 1200,
};

function setup(runtime: any, pending = false) {
  const tools = new Map<string, any>();
  const sent: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: () => undefined,
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx: any = { hasPendingMessages: () => pending };
  registerFusionTools(pi, { getRuntime: () => runtime, identity: () => ({ leadName: "lead", leadEffort: "medium", sidekickName: "side", sidekickEffort: "low" }) });
  return { tools, sent, ctx };
}

test("blocking sidekick returns a formatted report", async () => {
  const runtime = {
    handoff: () => ({ id: "h1", done: Promise.resolve(report) }),
    progress: () => undefined,
    reports: new Map([["h1", report]]),
    latest: () => ({ id: "h1", done: Promise.resolve(report), report }),
  };
  const { tools, ctx } = setup(runtime);
  const result = await tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /implemented/);
  assert.match(result.content[0].text, /sidekick h1/);
});

test("pending user message interrupts a blocking handoff", async () => {
  const runtime = {
    handoff: () => ({ id: "h2", done: new Promise(() => undefined) }),
    progress: (): HandoffProgress => ({ toolCalls: 1, recentTools: ["edit()"], textTail: "working", startedAt: Date.now() }),
    reports: new Map(),
    latest: () => ({ id: "h2", done: new Promise(() => undefined) }),
  };
  const { tools, ctx } = setup(runtime, true);
  const result = await tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /agent_id h2/);
  assert.match(result.content[0].text, /user message arrived/);
});

test("inactive Fusion returns an error result", async () => {
  const { tools, ctx } = setup(undefined);
  const result = await tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Fusion is not active/);
});

test("read_subagent defaults to the latest handoff", async () => {
  const runtime = {
    reports: new Map([["h1", report]]),
    latest: () => ({ id: "h1", done: Promise.resolve(report), report }),
    progress: () => undefined,
  };
  const { tools, ctx } = setup(runtime);
  const result = await tools.get("read_subagent").execute("call", {}, undefined, undefined, ctx);
  assert.match(result.content[0].text, /implemented/);
});

test("non-blocking sidekick sends a follow-up completion message", async () => {
  let resolve!: (value: HandoffReport) => void;
  const runtime = {
    handoff: () => ({ id: "h3", done: new Promise<HandoffReport>((r) => { resolve = r; }) }),
    progress: () => undefined,
    reports: new Map(),
    latest: () => undefined,
  };
  const { tools, sent, ctx } = setup(runtime);
  const result = await tools.get("sidekick").execute("call", { message: "work", block: false }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /h3 started/);
  resolve({ ...report, id: "h3" });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(sent[0]?.message.customType, "sidekick-completion");
  assert.equal(sent[0]?.options.deliverAs, "followUp");
});
