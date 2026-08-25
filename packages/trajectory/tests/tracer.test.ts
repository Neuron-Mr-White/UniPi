import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUnipiTracer } from "../src/tracer.js";

function harness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const bus = new Map<string, Array<(data: unknown) => void>>();
  const calls: Array<[string, unknown[]]> = [];
  const pi = {
    events: {
      emit(channel: string, data: unknown) { for (const handler of bus.get(channel) ?? []) handler(data); },
      on(channel: string, handler: (data: unknown) => void) {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => bus.set(channel, (bus.get(channel) ?? []).filter(candidate => candidate !== handler));
      },
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendUserMessage(...args: unknown[]) { calls.push(["sendUserMessage", args]); },
    setActiveTools(...args: unknown[]) { calls.push(["setActiveTools", args]); },
    registerTool(tool: unknown) { calls.push(["registerTool", [tool]]); },
    registerCommand(name: string, options: unknown) { calls.push(["registerCommand", [name, options]]); },
  };
  return { pi, handlers, calls };
}

const ctx = { sessionManager: { getSessionId: () => "session" } };

test("scopes UniPi hook mutations and API actions by package", async () => {
  const { pi, handlers, calls } = harness();
  const tracer = createUnipiTracer(pi as never, mkdtempSync(join(tmpdir(), "unipi-tracer-")));
  const workflow = tracer.scope("workflow");
  const memory = tracer.scope("memory");

  workflow.on("session_start", () => {});
  await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
  workflow.on("context", (event) => ({ messages: [...event.messages, { role: "custom", content: "workflow" }] }));
  memory.on("context", (event) => { event.messages.push({ role: "custom", content: "memory" } as never); });
  const event = { type: "context", messages: [{ role: "user", content: "go" }] };
  for (const handler of handlers.get("context") ?? []) {
    const result = await handler(event, ctx) as { messages?: unknown[] } | undefined;
    if (result?.messages) event.messages = result.messages as never[];
  }
  workflow.sendUserMessage("next", { deliverAs: "followUp" });
  memory.setActiveTools(["read"]);

  assert.deepEqual(calls.map(([name]) => name), ["sendUserMessage", "setActiveTools"]);
  const traces = tracer.recorder.read().filter(item => item.type === "unipi-trace").map(item => item.data as Record<string, any>);
  assert.ok(traces.some(trace => trace.package === "workflow" && trace.hook === "context" && trace.phase === "exit" && trace.mutation?.changed === true && trace.mutation?.firstDifference?.kind === "inserted"));
  assert.ok(traces.some(trace => trace.package === "memory" && trace.hook === "context" && trace.phase === "exit" && trace.mutation?.changed === true && trace.mutation?.firstDifference?.kind === "inserted"));
  assert.ok(traces.some(trace => trace.package === "workflow" && trace.action === "sendUserMessage"));
  assert.ok(traces.some(trace => trace.package === "memory" && trace.action === "setActiveTools"));
});

test("attributes command and tool execution context mutations", async () => {
  const { pi, handlers, calls } = harness();
  const tracer = createUnipiTracer(pi as never, mkdtempSync(join(tmpdir(), "unipi-tracer-")));
  const scoped = tracer.scope("compactor");
  scoped.on("session_start", () => {});
  await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
  let compactCalls = 0;
  scoped.registerCommand("unipi:compact", { handler: (_args, commandCtx: any) => commandCtx.compact({ reason: "manual" }) } as never);
  scoped.registerTool({ name: "compact", description: "compact", parameters: {}, execute: (_id: string, _params: unknown, _signal: unknown, _update: unknown, toolCtx: any) => { toolCtx.compact(); return Promise.resolve({ content: [] }); } } as never);
  const command = calls.find(([name]) => name === "registerCommand")?.[1][1] as { handler(args: string, ctx: unknown): Promise<void> };
  const tool = calls.find(([name]) => name === "registerTool")?.[1][0] as { execute(...args: unknown[]): Promise<void> };
  const executionCtx = { ...ctx, compact: () => { compactCalls++; } };
  await command.handler("", executionCtx);
  await tool.execute("call", {}, undefined, undefined, executionCtx);
  assert.equal(compactCalls, 2);
  const traces = tracer.recorder.read().map(item => item.data as Record<string, any>);
  assert.ok(traces.some(trace => trace.package === "compactor" && trace.surface === "command" && trace.action === "unipi:compact"));
  assert.ok(traces.some(trace => trace.package === "compactor" && trace.surface === "tool" && trace.tool === "compact"));
  assert.equal(traces.filter(trace => trace.package === "compactor" && trace.surface === "context-api" && trace.action === "compact").length, 4);
});

test("records return-based system prompt changes without duplicating full prompts", async () => {
  const { pi, handlers } = harness();
  const tracer = createUnipiTracer(pi as never, mkdtempSync(join(tmpdir(), "unipi-tracer-")));
  const scoped = tracer.scope("workflow");
  scoped.on("session_start", () => {});
  await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
  scoped.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nextra` }));
  await handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", systemPrompt: "base", systemPromptOptions: {}, prompt: "go" }, ctx);
  const trace = tracer.recorder.read().map(item => item.data as Record<string, any>)
    .find(item => item.package === "workflow" && item.hook === "before_agent_start" && item.phase === "exit");
  assert.equal(trace?.mutation?.changed, true);
  assert.equal(trace?.mutation?.firstDifference?.path, "$.systemPrompt");
  assert.match(trace?.result?.fingerprint ?? "", /^[0-9a-f]{16}$/);
});

test("flushes extension-load registration traces when the session binds", async () => {
  const { pi, handlers } = harness();
  const tracer = createUnipiTracer(pi as never, mkdtempSync(join(tmpdir(), "unipi-tracer-")));
  const scoped = tracer.scope("memory");
  scoped.registerTool({ name: "memory_store", description: "store", parameters: {}, execute: async () => ({ content: [] }) } as never);
  assert.equal(tracer.recorder.read().length, 0);
  scoped.on("session_start", () => {});
  await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
  const traces = tracer.recorder.read().map(item => item.data as Record<string, any>);
  assert.ok(traces.some(trace => trace.package === "memory" && trace.action === "registerTool"));
});

test("attributes event-bus delivery and handler errors", async () => {
  const { pi, handlers } = harness();
  const tracer = createUnipiTracer(pi as never, mkdtempSync(join(tmpdir(), "unipi-tracer-")));
  const scoped = tracer.scope("ralph");
  scoped.on("session_start", () => {});
  await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
  scoped.events.on("unipi:test", () => { throw new Error("boom"); });
  assert.throws(() => scoped.events.emit("unipi:test", { ok: true }), /boom/);
  const traces = tracer.recorder.read().map(item => item.data as Record<string, any>);
  assert.ok(traces.some(trace => trace.package === "ralph" && trace.surface === "event-bus" && trace.phase === "emit"));
  assert.ok(traces.some(trace => trace.package === "ralph" && trace.surface === "event-bus" && trace.phase === "error" && trace.error?.message === "boom"));
});
