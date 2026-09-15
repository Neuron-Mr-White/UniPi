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

function runtimeWith(child: ReturnType<typeof fakeChild>) {
  return new SidekickRuntime({
    cwd: "/tmp",
    model: "b/glm",
    thinking: "low",
    sessionFile: "/tmp/sidekick.jsonl",
    systemPrompt: "sidekick",
    command: { command: "fake-pi", args: [] },
    spawn: (() => child) as never,
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
