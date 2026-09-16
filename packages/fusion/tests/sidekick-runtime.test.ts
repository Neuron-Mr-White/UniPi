import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SidekickRuntime } from "../src/sidekick-runtime.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("close");
    return true;
  };
  return child;
}

function runtimeWith(child: ReturnType<typeof fakeChild>, settleGraceMs?: number) {
  return new SidekickRuntime({
    cwd: "/tmp",
    model: "b/glm",
    thinking: "low",
    sessionFile: "/tmp/sidekick.jsonl",
    systemPrompt: "sidekick",
    command: { command: "fake-pi", args: [] },
    spawn: (() => child) as never,
    settleGraceMs,
  });
}

function emit(child: ReturnType<typeof fakeChild>, value: unknown, crlf = false) {
  child.stdout.write(`${JSON.stringify(value)}${crlf ? "\r\n" : "\n"}`);
}

function commands(child: ReturnType<typeof fakeChild>): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) if (line) values.push(JSON.parse(line) as Record<string, unknown>);
  });
  return values;
}

test("runtime completes a handoff and sums usage", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("do work");
  emit(child, { type: "response", command: "prompt", success: true });
  emit(child, { type: "tool_execution_start", toolName: "bash", args: { command: "echo hi" } });
  emit(child, { type: "tool_execution_start", toolName: "edit", args: {} });
  emit(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } });
  emit(child, { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } } } });
  emit(child, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "finished" } });
  const report = await handoff.done;
  assert.equal(report.status, "completed");
  assert.equal(report.text, "finished");
  assert.equal(report.toolCalls, 2);
  assert.equal(runtime.totalToolCalls(), 2);
  assert.deepEqual(report.usage, { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.5 });
  assert.equal(sent[0]?.type, "prompt");
  assert.equal(sent.at(-1)?.type, "get_last_assistant_text");
  runtime.kill();
});

test("bg_run keeps the handoff open across agent_settled", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("background work");
  emit(child, { type: "response", command: "prompt", success: true });
  emit(child, { type: "tool_execution_start", toolCallId: "bg-1", toolName: "bg_run", args: { command: "x" } });
  emit(child, { type: "tool_execution_end", toolCallId: "bg-1", isError: false });
  emit(child, { type: "agent_settled" });
  assert.equal(runtime.isBusy(), true);
  assert.equal(sent.some((command) => command.type === "get_last_assistant_text"), false);
  emit(child, { type: "message_end", message: { role: "custom", customType: "background-task-notification", content: "done" } });
  emit(child, { type: "agent_start" });
  emit(child, { type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "echo final" } });
  emit(child, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "final" } });
  const report = await handoff.done;
  assert.equal(report.status, "completed");
  assert.equal(report.text, "final");
  assert.equal(report.toolCalls, 2);
  runtime.kill();
});

test("bg notification without a follow-up turn finishes after grace", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child, 25);
  const handoff = runtime.handoff("background work");
  emit(child, { type: "response", command: "prompt", success: true });
  emit(child, { type: "tool_execution_start", toolCallId: "bg-1", toolName: "bg_run", args: { command: "x" } });
  emit(child, { type: "tool_execution_end", toolCallId: "bg-1", isError: false });
  emit(child, { type: "agent_settled" });
  emit(child, { type: "message_end", message: { role: "custom", customType: "background-task-notification", content: "done" } });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(sent.at(-1)?.type, "get_last_assistant_text");
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "final" } });
  assert.equal((await handoff.done).text, "final");
  runtime.kill();
});

test("bg_run with triggerOnCompletion:false does not hold the handoff", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("background work");
  emit(child, { type: "response", command: "prompt", success: true });
  emit(child, { type: "tool_execution_start", toolCallId: "bg-1", toolName: "bg_run", args: { command: "x", triggerOnCompletion: false } });
  emit(child, { type: "tool_execution_end", toolCallId: "bg-1", isError: false });
  emit(child, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sent.at(-1)?.type, "get_last_assistant_text");
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "final" } });
  assert.equal((await handoff.done).status, "completed");
  runtime.kill();
});

test("prompt rejected as already processing is retried as followUp", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("continue work");
  emit(child, { type: "response", command: "prompt", success: false, error: "Agent is already processing…" });
  assert.deepEqual(sent[1], { id: sent[0]?.id, type: "prompt", message: "continue work", streamingBehavior: "followUp" });
  emit(child, { type: "response", command: "prompt", success: true });
  emit(child, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "final" } });
  assert.equal((await handoff.done).status, "completed");
  runtime.kill();
});

test("prompt followUp rejection resolves an error report", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("continue work");
  emit(child, { type: "response", command: "prompt", success: false, error: "Agent is already processing" });
  emit(child, { type: "response", command: "prompt", success: false, error: "Agent is already processing again" });
  const report = await handoff.done;
  assert.equal(report.status, "error");
  assert.equal(runtime.reports.get(handoff.id), report);
  assert.match(report.error ?? "", /already processing again/);
  assert.equal(sent.length, 2);
  runtime.kill();
});

test("busy handoff steers the same promise", async () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  const first = runtime.handoff("first");
  emit(child, { type: "response", command: "prompt", success: true });
  const second = runtime.handoff("redirect");
  assert.equal(second.id, first.id);
  assert.equal(second.done, first.done);
  assert.equal(sent.at(-1)?.type, "steer");
  runtime.kill();
  assert.equal((await first.done).status, "error");
});

test("extension UI requests are cancelled", () => {
  const child = fakeChild();
  const sent = commands(child);
  const runtime = runtimeWith(child);
  runtime.handoff("ui");
  emit(child, { type: "extension_ui_request", id: "ui-1", method: "select" });
  assert.deepEqual(sent.at(-1), { type: "extension_ui_response", id: "ui-1", cancelled: true });
  runtime.kill();
});

test("child close while busy reports an error", async () => {
  const child = fakeChild();
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("crash");
  child.exitCode = 1;
  child.emit("close");
  const report = await handoff.done;
  assert.equal(report.status, "error");
  runtime.kill();
});

test("runtime records structured text and tool events", async () => {
  const child = fakeChild();
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("events");
  emit(child, { type: "response", command: "prompt", success: true });
  emit(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Plan." } });
  emit(child, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "ls" } });
  emit(child, { type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }, isError: false });
  emit(child, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } });
  emit(child, { type: "message_end", message: { role: "assistant", usage: {} } });
  const progress = runtime.progress();
  assert.deepEqual(progress?.events, [
    { kind: "text", text: "Plan.", open: false },
    { kind: "tool", toolCallId: "tool-1", name: "bash", args: { command: "ls" }, output: "a\nb", isError: false, done: true, startedAt: progress?.events[1]?.kind === "tool" ? progress.events[1].startedAt : 0, endedAt: progress?.events[1]?.kind === "tool" ? progress.events[1].endedAt : undefined },
    { kind: "text", text: "Done.", open: false },
  ]);
  emit(child, { type: "agent_settled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "Done." } });
  const report = await handoff.done;
  assert.equal(report.events.length, 3);
  runtime.kill();
});

test("runtime caps structured events and counts dropped events", () => {
  const child = fakeChild();
  const runtime = runtimeWith(child);
  runtime.handoff("cap");
  for (let i = 0; i < 305; i++) emit(child, { type: "tool_execution_start", toolCallId: `tool-${i}`, toolName: "bash", args: { command: "ls" } });
  const progress = runtime.progress();
  assert.equal(progress?.events.length, 300);
  assert.equal(progress?.droppedEvents, 5);
  runtime.kill();
});

test("CRLF records are accepted", async () => {
  const child = fakeChild();
  const runtime = runtimeWith(child);
  const handoff = runtime.handoff("crlf");
  emit(child, { type: "response", command: "prompt", success: true }, true);
  emit(child, { type: "agent_settled" }, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  emit(child, { type: "response", command: "get_last_assistant_text", success: true, data: { text: "ok" } }, true);
  assert.equal((await handoff.done).text, "ok");
  runtime.kill();
});
