import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerTelemetryCapture } from "../src/capture.js";
import { createUnipiTracer } from "../src/tracer.js";

test("captures the effective system prompt and observable hook lifecycle", () => {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
  };
  const readTelemetry = registerTelemetryCapture(pi as never, mkdtempSync(join(tmpdir(), "trajectory-capture-")));
  const ctx = {
    sessionManager: { getSessionId: () => "s" },
    getSystemPrompt: () => "final system prompt",
    model: { provider: "p", id: "m" },
    thinkingLevel: "high",
  };
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  handlers.get("before_agent_start")?.({
    type: "before_agent_start",
    prompt: "debug this",
    systemPrompt: "observed prompt",
    systemPromptOptions: { cwd: "/tmp", selectedTools: ["read"] },
  }, ctx);
  handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 10 }, ctx);
  handlers.get("context")?.({ type: "context", messages: [{ role: "user", content: "debug this" }] }, ctx);
  handlers.get("before_provider_headers")?.({ type: "before_provider_headers", headers: { Authorization: "Bearer hidden" } }, ctx);
  handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: { model: "m", messages: [] } }, ctx);
  handlers.get("message_update")?.({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: { role: "assistant", content: "hi" } },
  }, ctx);
  handlers.get("message_end")?.({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: {}, stopReason: "stop" },
  }, ctx);

  const events = readTelemetry();
  const system = events.find(event => event.type === "system-prompt");
  assert.equal((system?.data as { systemPrompt?: string }).systemPrompt, "final system prompt");
  assert.deepEqual(
    events.filter(event => event.type === "hook").map(event => (event.data as { name?: string }).name),
    ["session_start", "before_agent_start", "agent_start", "turn_start", "context", "before_provider_headers", "message_update", "message_end"],
  );
  const headerHook = events.find(event => event.type === "hook" && (event.data as { name?: string }).name === "before_provider_headers");
  assert.equal(
    (headerHook?.data as { payload?: { headers?: { Authorization?: string } } }).payload?.headers?.Authorization,
    "[REDACTED]",
  );
  assert.equal(events.find(event => event.type === "request")?.requestId, 1);
  const stream = events.find(event => event.type === "hook" && (event.data as { name?: string }).name === "message_update");
  const firstStreamEvent = (stream?.data as { payload?: { events?: Array<Record<string, unknown>> } }).payload?.events?.[0];
  assert.equal(firstStreamEvent?.delta, "hi");
  assert.equal("partial" in (firstStreamEvent ?? {}), false);
});

test("attributes a provider prefix violation to contributing UniPi mutations", () => {
  const root = mkdtempSync(join(tmpdir(), "trajectory-attribution-"));
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    events: { emit() {}, on() { return () => {}; } },
    on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
    sendUserMessage() {},
  };
  const tracer = createUnipiTracer(pi as never, root);
  const readTelemetry = registerTelemetryCapture(pi as never, root, tracer.recorder);
  const ctx = {
    sessionManager: { getSessionId: () => "prefix" },
    getSystemPrompt: () => "system",
    model: { provider: "p", id: "m" },
  };
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 1 }, ctx);
  handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: { model: "m", messages: [{ role: "user", content: "one" }] } }, ctx);
  tracer.recorder.record({ package: "memory", surface: "hook", phase: "exit", hook: "context", mutation: { changed: true, firstDifference: { path: "$[0]" } } });
  handlers.get("message_end")?.({ type: "message_end", message: { role: "assistant", content: [], usage: {}, stopReason: "stop" } }, ctx);
  handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: 2 }, ctx);
  handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: { model: "m", messages: [{ role: "custom", content: "injected" }, { role: "user", content: "one" }] } }, ctx);
  const integrity = readTelemetry().filter(event => event.type === "prefix-integrity").at(-1)?.data as { verdict?: string; attribution?: Array<{ package?: string }> };
  assert.equal(integrity.verdict, "violation");
  assert.equal(integrity.attribution?.[0]?.package, "memory");
});
