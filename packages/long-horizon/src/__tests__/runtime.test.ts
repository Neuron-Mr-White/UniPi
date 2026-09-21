import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyToolCall, extractTail, sumUsageTokens, wireRuntime } from "../runtime.js";
import { GoalMachine } from "../engine/goal-state.js";
import { GoalToolset } from "../tools/goal.js";
import { GoalContinuation } from "../engine/continuation.js";
import { OwnerCoordinator } from "../owner.js";
import { Gate } from "../gate.js";
import { DEFAULT_SETTINGS } from "../settings.js";

// ── pure helpers ─────────────────────────────────────────────────────────

test("classifyToolCall extracts commands and files", () => {
  assert.deepEqual(classifyToolCall("bash", { command: "npm test" }), { command: "npm test" });
  assert.deepEqual(classifyToolCall("edit", { path: "src/a.ts" }), { file: "src/a.ts" });
  assert.deepEqual(classifyToolCall("write", { file_path: "b.ts" }), { file: "b.ts" });
  assert.deepEqual(classifyToolCall("read", {}), {});
  assert.deepEqual(classifyToolCall("spawn_helper", { prompt: "x" }), {});
});

test("extractTail bounds roles/text and drops empties", () => {
  const messages = [
    { role: "user", content: "start" },
    { role: "assistant", content: [{ type: "text", text: "a" }] },
    { role: "assistant", content: "b" },
    { role: "assistant", content: "" },
    { role: "assistant", content: [{ type: "tool_use", id: "1" }] },
  ];
  const tail = extractTail(messages, 5);
  assert.deepEqual(
    tail.map((t) => t.text),
    ["start", "a", "b"],
  );
  const limited = extractTail(
    Array.from({ length: 9 }, (_, i) => ({ role: "user", content: `m${i}` })),
    5,
  );
  assert.equal(limited.length, 5);
  assert.equal(limited[0]?.text, "m4");
});

test("sumUsageTokens prefers totalTokens, falls back to input+output", () => {
  const total = sumUsageTokens([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok", usage: { totalTokens: 100 } },
    { role: "assistant", content: "ok2", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  assert.equal(total, 115);
  assert.equal(sumUsageTokens([{ role: "user", content: "x" }]), undefined);
});

// ── full wiring against a fake pi ────────────────────────────────────────

interface FakePi {
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  sent: string[];
  registerTool(tool: { name: string }): void;
  registerCommand(name: string): void;
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  sendUserMessage(content: string): void;
  emit(event: string, payload: unknown): void;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi: FakePi = {
    handlers,
    sent: [],
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler as (event: unknown, ctx: unknown) => unknown);
      handlers.set(event, list);
    },
    sendUserMessage: (content) => {
      pi.sent.push(content);
    },
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) void handler(payload, {});
    },
  };
  return pi;
}

async function fire(pi: FakePi, event: string, payload: unknown): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) await handler(payload, {});
}

test("wiring drives the loop: tool_call → agent_end → kickoff → hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-runtime-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const pi = fakePi();
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("no verify in this test"); } },
    send: (message) => pi.sendUserMessage(message),
  });
  wireRuntime(pi as never, { machine, toolset, continuation, gate, loadSettings: () => DEFAULT_SETTINGS });

  // Create a goal (as the model would) and end the turn with tool activity.
  machine.create("objective", { tokenBudget: null });
  owner.activate("goal", "objective");
  pi.emit("tool_call", { toolName: "bash", input: { command: "npm test" } });
  pi.emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } });
  await fire(pi, "agent_end", {
    messages: [
      { role: "user", content: "do it" },
      { role: "assistant", content: "done for now", usage: { totalTokens: 1200 } },
    ],
  });

  // Kickoff delivered first (cache-stable), no settlement yet.
  assert.match(pi.sent[0] ?? "", /Continue working toward the active thread goal/);
  assert.equal(machine.get()?.kickoffDelivered, true);

  // Second turn: tools + agent_end → one-line hint with the status line.
  pi.emit("tool_call", { toolName: "bash", input: { command: "npm test" } });
  await fire(pi, "agent_end", {
    messages: [
      { role: "user", content: "kickoff" },
      { role: "assistant", content: "progress", usage: { totalTokens: 2400 } },
    ],
  });
  assert.match(pi.sent[1] ?? "", /turn 1\/50/);
  assert.equal(machine.get()?.turn, 1);
  // Baseline landed at the first settlement (2400 — the kickoff turn did not settle).
  assert.equal(machine.get()?.tokensAtStart, 2400);

  rmSync(dir, { recursive: true, force: true });
});

test("plain-mode (none) turns do not feed the loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-runtime2-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const pi = fakePi();
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  // Simulate the gate having resolved `none` for the current turn.
  await gate.resolveForTurnWith?.(undefined as never);
  (gate as unknown as { turn: { mode: string } | null }).turn = { mode: "none" };
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => "unused" },
    send: (message) => pi.sendUserMessage(message),
  });
  wireRuntime(pi as never, { machine, toolset, continuation, gate, loadSettings: () => DEFAULT_SETTINGS });

  pi.emit("tool_call", { toolName: "bash", input: { command: "ls" } });
  await fire(pi, "agent_end", { messages: [] });
  // No goal exists → nothing sent regardless; the none-guard is on the accumulator.
  assert.equal(pi.sent.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("compaction arms the recovery fragment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-runtime3-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const pi = fakePi();
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => "unused" },
    send: (message) => pi.sendUserMessage(message),
  });
  wireRuntime(pi as never, { machine, toolset, continuation, gate, loadSettings: () => DEFAULT_SETTINGS });

  machine.create("objective");
  owner.activate("goal", "objective");
  await fire(pi, "agent_end", { messages: [] }); // kickoff
  await fire(pi, "session_compact", {});
  pi.emit("tool_call", { toolName: "bash", input: { command: "ls" } });
  await fire(pi, "agent_end", { messages: [] });
  assert.match(pi.sent[1] ?? "", /Goal recovery/);
  rmSync(dir, { recursive: true, force: true });
});
