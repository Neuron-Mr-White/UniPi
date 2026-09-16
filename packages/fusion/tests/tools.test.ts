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

function setup(runtime: any, pending = false, callbacks: any = {}) {
  const tools = new Map<string, any>();
  const renderers = new Map<string, any>();
  const sent: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  const ctx: any = { hasPendingMessages: () => pending };
  registerFusionTools(pi, { getRuntime: () => runtime, ...callbacks });
  return { tools, renderers, sent, ctx };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("blocking sidekick returns a formatted report", async () => {
  const runtime = {
    isBusy: () => false,
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
    isBusy: () => false,
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

test("read_subagent background progress keeps transcript details", async () => {
  const progress: HandoffProgress = {
    toolCalls: 1,
    recentTools: ["bash(ls)"],
    textTail: "working",
    startedAt: Date.now(),
    events: [{ kind: "text", text: "working", open: true }],
    droppedEvents: 0,
  };
  const runtime = {
    reports: new Map(),
    latest: () => ({ id: "h-progress", done: new Promise(() => undefined) }),
    progress: () => progress,
  };
  const { tools, ctx } = setup(runtime);
  const result = await tools.get("read_subagent").execute("call", { block: false }, undefined, undefined, ctx);
  assert.deepEqual(result.details.progress.events, progress.events);
});

test("sidekick attach and detach callbacks follow wait mode", async () => {
  const calls: string[] = [];
  const blockingRuntime = {
    isBusy: () => false,
    handoff: () => ({ id: "h-block", done: Promise.resolve(report) }),
    progress: () => undefined,
    reports: new Map([["h-block", report]]),
    latest: () => ({ id: "h-block", done: Promise.resolve(report), report }),
  };
  const blocking = setup(blockingRuntime, false, { onAttach: () => calls.push("attach"), onDetach: () => calls.push("detach") });
  await blocking.tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, blocking.ctx);
  assert.deepEqual(calls, ["attach"]);

  let resolve!: (value: HandoffReport) => void;
  const detachedRuntime = {
    isBusy: () => false,
    handoff: () => ({ id: "h-detached", done: new Promise<HandoffReport>((res) => { resolve = res; }) }),
    progress: () => undefined,
    reports: new Map(),
    latest: () => undefined,
  };
  const detached = setup(detachedRuntime, false, { onAttach: () => calls.push("attach"), onDetach: () => calls.push("detach") });
  await detached.tools.get("sidekick").execute("call", { message: "work", block: false }, undefined, undefined, detached.ctx);
  assert.deepEqual(calls, ["attach", "detach"]);
  resolve(report);

  const interruptedRuntime = {
    isBusy: () => false,
    handoff: () => ({ id: "h-interrupted", done: new Promise(() => undefined) }),
    progress: () => undefined,
    reports: new Map(),
    latest: () => undefined,
  };
  const interrupted = setup(interruptedRuntime, true, { onAttach: () => calls.push("attach"), onDetach: () => calls.push("detach") });
  await interrupted.tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, interrupted.ctx);
  assert.deepEqual(calls, ["attach", "detach", "attach", "detach"]);
});

test("read_subagent turns a rejected handoff into an error result", async () => {
  const done = Promise.reject(new Error("boom"));
  const runtime = {
    reports: new Map(),
    latest: () => ({ id: "h-error", done }),
    progress: () => undefined,
  };
  const { tools, ctx } = setup(runtime);
  const result = await tools.get("read_subagent").execute("call", { block: true }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});

test("non-blocking sidekick sends a follow-up completion message", async () => {
  let resolve!: (value: HandoffReport) => void;
  const runtime = {
    isBusy: () => false,
    handoff: () => ({ id: "h3", done: new Promise<HandoffReport>((r) => { resolve = r; }) }),
    progress: () => undefined,
    reports: new Map(),
    latest: () => undefined,
  };
  const { tools, sent, ctx } = setup(runtime);
  const result = await tools.get("sidekick").execute("call", { message: "work", block: false }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /h3 started/);
  assert.equal(result.details.background, true);
  const rendered = tools.get("sidekick").renderResult(result, {}, theme).render(120).join("\n");
  assert.doesNotMatch(rendered, /read_subagent/);
  assert.match(rendered, /continuing in background/);
  resolve({ ...report, id: "h3" });
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(sent[0]?.message.customType, "sidekick-completion");
  assert.equal(sent[0]?.options.deliverAs, "followUp");
  // Without triggerTurn the completion would sit in the transcript and never
  // wake the lead, leaving the sidekick's result unread.
  assert.equal(sent[0]?.options.triggerTurn, true);
});

test("a completion card bubbles the sidekick transcript onto the main surface", () => {
  const run = setup({} as any);
  const events = [
    { kind: "tool", toolCallId: "1", name: "bash", args: { command: "npm test" }, output: "all green", isError: false, done: true, startedAt: 0 },
    { kind: "text", text: "implemented", open: false },
  ];
  const card = run.renderers.get("sidekick-completion")({ details: { ...report, events } }, {}, theme).render(120).join("\n");
  assert.match(card, /▍/, "sidekick-origin output is rail-marked");
  assert.match(card, /sidekick completed/);
  assert.match(card, /bash/);
  assert.match(card, /all green/);
  assert.match(card, /implemented/);
  assert.doesNotMatch(card, /steps · expand/);
});

const uuidId = "ecff5344-4e60-4892-8a86-1f8e962caf1b";
const PROTOCOL = /ecff5344|subagent_completion|use `?read_subagent|agent_id/i;

test("rendered sidekick output hides handoff ids and protocol text", async () => {
  const uuidReport: HandoffReport = {
    ...report,
    id: uuidId,
    events: [
      { kind: "tool", toolCallId: "1", name: "bash", args: { command: "npm test" }, output: "ok", isError: false, done: true, startedAt: 0 },
      { kind: "text", text: "implemented", open: false },
    ],
  };
  const runtime = {
    isBusy: () => false,
    handoff: () => ({ id: uuidId, done: Promise.resolve(uuidReport) }),
    progress: () => undefined,
    reports: new Map([[uuidId, uuidReport]]),
    latest: () => ({ id: uuidId, done: Promise.resolve(uuidReport), report: uuidReport }),
  };
  const { tools, ctx } = setup(runtime);

  // Blocking report: the sidekick's own transcript, rail-marked as sidekick
  // output — no id, no protocol text.
  const result = await tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, ctx);
  const rendered = tools.get("sidekick").renderResult(result, {}, theme).render(120).join("\n");
  assert.doesNotMatch(rendered, PROTOCOL);
  assert.match(rendered, /▍/);
  assert.match(rendered, /sidekick completed/);
  assert.match(rendered, /implemented/);

  // The call and result renderers never echo the agent id.
  const call = tools.get("read_subagent").renderCall({ agent_id: uuidId, block: true }, theme).render(120).join("\n");
  assert.doesNotMatch(call, PROTOCOL);

  const read = await tools.get("read_subagent").execute("call", { block: true }, undefined, undefined, ctx);
  const readRendered = tools.get("read_subagent").renderResult(read, {}, theme).render(120).join("\n");
  assert.doesNotMatch(readRendered, PROTOCOL);
});

test("fusion tools use the default render shell so pi paints the standard tool background", () => {
  const runtime = {
    isBusy: () => false,
    handoff: () => ({ id: "h1", done: Promise.resolve(report) }),
    progress: () => undefined,
    reports: new Map(),
    latest: () => undefined,
  };
  const { tools } = setup(runtime);
  // "self" bypasses ToolExecutionComponent's toolPendingBg/toolSuccessBg box,
  // which leaves sidekick blocks unhighlighted next to ordinary tool activity.
  for (const name of ["sidekick", "read_subagent"]) {
    assert.notEqual(tools.get(name).renderShell, "self");
  }
});

test("rendered fallback text strips ids and instructions", () => {
  const runtime = {
    isBusy: () => false,
    handoff: () => ({ id: uuidId, done: Promise.reject(new Error("boom")) }),
    progress: () => undefined,
    reports: new Map(),
    latest: () => ({ id: uuidId, done: Promise.reject(new Error("boom")) }),
  };
  const { tools, ctx } = setup(runtime);
  return tools.get("sidekick").execute("call", { message: "work" }, undefined, undefined, ctx).then((result: any) => {
    const rendered = tools.get("sidekick").renderResult(result, {}, theme).render(120).join("\n");
    assert.doesNotMatch(rendered, PROTOCOL);
    assert.match(rendered, /The handoff failed: boom/);
  });
});
