import assert from "node:assert/strict";
import test from "node:test";
import { projectTrajectory } from "../src/project.js";

const entry = (id: string, message: Record<string, unknown>, parentId: string | null = null) => ({
  type: "message", id, parentId, timestamp: new Date(message.timestamp as number).toISOString(), message,
});

test("projects turns, assistant usage, and paired tool timing", () => {
  const entries = [
    entry("u", { role: "user", content: "Fix it", timestamp: 1000 }),
    entry("a", { role: "assistant", timestamp: 1100, provider: "p", model: "m", stopReason: "toolUse", usage: { input: 4, output: 2, cacheRead: 8, cacheWrite: 0, totalTokens: 14, cost: { total: 0.1 } }, content: [{ type: "thinking", thinking: "inspect" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] }, "u"),
    entry("t", { role: "toolResult", timestamp: 1250, toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: "hello" }] }, "a"),
    entry("a2", { role: "assistant", timestamp: 1300, provider: "p", model: "m", stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text: "Done" }] }, "t"),
  ];
  const snapshot = projectTrajectory(entries as never[], { sessionId: "s" });
  assert.deepEqual(snapshot.records.map(record => [record.kind, record.turn, record.step]), [
    ["user", 1, null], ["assistant", 1, 1], ["tool", 1, 1], ["assistant", 1, 2],
  ]);
  const tool = snapshot.records[2]!;
  assert.equal(tool.durationMs, 150);
  assert.deepEqual(tool.output, [{ type: "text", text: "hello" }]);
  assert.equal(snapshot.records[1]!.usage?.cacheRead, 8);
  assert.equal(snapshot.records[1]!.thinking, "inspect");
});

test("joins request and tool telemetry without changing session entries", () => {
  const entries = [
    entry("u", { role: "user", content: "go", timestamp: 1000 }),
    entry("a", { role: "assistant", timestamp: 1100, provider: "p", model: "m", stopReason: "toolUse", usage: {}, content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }] }),
  ];
  const snapshot = projectTrajectory(entries as never[], { sessionId: "s" }, [
    { v: 1, type: "request", at: 1000, requestId: 1, data: { payload: { temperature: 0 }, tools: [{ name: "read" }] } },
    { v: 1, type: "message-end", at: 1250, requestId: 1, data: { ttftMs: 40, decodingMs: 110, totalMs: 150 } },
    { v: 1, type: "tool-end", at: 1300, toolCallId: "c1", data: { durationMs: 75 } },
  ]);
  assert.deepEqual(snapshot.records[1]!.timing, { ttftMs: 40, decodingMs: 110, totalMs: 150 });
  assert.equal(snapshot.records[1]!.durationMs, 150);
  assert.deepEqual(snapshot.records[1]!.tools, [{ name: "read" }]);
  assert.equal(snapshot.records[2]!.durationMs, 75);
});

test("request matching ignores earlier hook-only request ids", () => {
  const entries = [
    entry("u", { role: "user", content: "go", timestamp: 1000 }),
    entry("a", { role: "assistant", timestamp: 1200, provider: "p", model: "m", stopReason: "stop", usage: {}, content: [{ type: "text", text: "done" }] }),
  ];
  const snapshot = projectTrajectory(entries as never[], { sessionId: "s" }, [
    { v: 1, type: "hook", at: 1050, requestId: 1, data: { name: "turn_start", payload: {} } },
    { v: 1, type: "request", at: 1100, requestId: 1, data: { payload: { model: "m" } } },
  ]);
  assert.deepEqual(snapshot.records.find(record => record.kind === "assistant")?.request, { payload: { model: "m" } });
});

test("projects only provider-context telemetry into the ledger", () => {
  const snapshot = projectTrajectory([
    entry("u", { role: "user", content: "go", timestamp: 1000 }),
  ] as never[], { sessionId: "s" }, [
    { v: 1, type: "hook", at: 900, data: { name: "before_agent_start", payload: { prompt: "go" } } },
    { v: 1, type: "system-prompt", at: 950, runId: 1, data: { systemPrompt: "You are Pi", systemPromptOptions: { cwd: "/tmp" } } },
    { v: 1, type: "hook", at: 1050, requestId: 1, turnIndex: 0, data: { name: "context", payload: { messages: [{ role: "user", content: "go" }] } } },
  ]);
  assert.deepEqual(snapshot.records.map(record => record.kind), ["system", "user"]);
  assert.equal(snapshot.records[0]!.output, "You are Pi");
  assert.equal(snapshot.records[1]!.turn, 1);
});

test("projects UniPi package traces and prefix verdicts", () => {
  const snapshot = projectTrajectory([] as never[], { sessionId: "s" }, [
    { v: 1, type: "unipi-trace", at: 90, data: { package: "notify", surface: "hook", phase: "exit", hook: "agent_end", affectsContext: false, durationMs: 1 } },
    { v: 1, type: "unipi-trace", at: 100, data: { package: "memory", surface: "hook", phase: "exit", hook: "context", mutation: { changed: true }, affectsContext: true, durationMs: 2 } },
    { v: 1, type: "prefix-integrity", at: 110, requestId: 1, data: { verdict: "violation", epoch: 2, differences: [{ surface: "messages", path: "$.messages[3]" }], attribution: [{ package: "memory" }] } },
  ]);
  assert.deepEqual(snapshot.records.map(record => record.kind), ["unipi", "prefix"]);
  assert.equal(snapshot.records[0]?.package, "memory");
  assert.equal(snapshot.records[0]?.durationMs, 2);
  assert.equal(snapshot.records[1]?.verdict, "violation");
  assert.equal(snapshot.records[1]?.isError, true);
  assert.match(snapshot.records[1]?.preview ?? "", /messages\[3\]/);
});

test("keeps compaction between turns without inventing timing", () => {
  const snapshot = projectTrajectory([{
    type: "compaction", id: "c", parentId: null, timestamp: "2025-01-01T00:00:00Z",
    summary: "Earlier work", tokensBefore: 5000,
  }] as never[], { sessionId: "s" });
  assert.equal(snapshot.records[0]!.kind, "compaction");
  assert.equal(snapshot.records[0]!.turn, null);
  assert.equal(snapshot.records[0]!.durationMs, null);
  assert.equal(snapshot.records[0]!.tokensBefore, 5000);
});
