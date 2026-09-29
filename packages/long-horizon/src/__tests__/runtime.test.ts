import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyToolCall, estimateTokens, extractTail, sumUsageTokens, wireRuntime } from "../runtime.js";
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
  assert.deepEqual(classifyToolCall("run_subagent", { task: "x" }), {});
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

// ── FIX 3: pi usage shape + estimation ───────────────────────────────────

test("sumUsageTokens counts pi's {input, output, cacheRead, ...} usage shape", () => {
  const total = sumUsageTokens([
    {
      role: "assistant",
      content: "ok",
      usage: { input: 2463, output: 143, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 2606 },
    },
    {
      role: "assistant",
      content: "ok2",
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 0 }, // no totalTokens
    },
    { role: "assistant", content: "legacy", usage: { inputTokens: 7, outputTokens: 2 } },
  ]);
  assert.equal(total, 2606 + 15 + 9);
});

test("estimateTokens covers assistant text, thinking, tool args, and toolResult text", () => {
  const estimate = estimateTokens([
    { role: "user", content: "ignored user text 12345678" },
    { role: "assistant", content: [{ type: "text", text: "abcd" }, { type: "thinking", thinking: "efgh" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ij" } }] },
    { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "kl" }] },
  ]);
  const chars = 4 + 4 + JSON.stringify({ command: "ij" }).length + 2;
  assert.equal(estimate, Math.ceil(chars / 4));
});

test("a usage-less turn estimates tokens and the budget fires on the estimate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-runtime-est-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const pi = fakePi();
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("no verify"); } },
    send: (message) => pi.sendUserMessage(message),
  });
  wireRuntime(pi as never, { machine, toolset, continuation, gate, loadSettings: () => DEFAULT_SETTINGS });
  machine.create("bounded", { tokenBudget: 10 });
  owner.activate("goal", "bounded");
  // Kickoff turn.
  await fire(pi, "agent_end", { messages: [{ role: "user", content: "go" }] });
  // Turn with assistant text but NO usage anywhere → estimate arms the counter.
  await fire(pi, "agent_end", {
    messages: [
      { role: "user", content: "x".repeat(100) },
      { role: "assistant", content: "y".repeat(100) },
    ],
  });
  const goal = machine.get()!;
  assert.equal(goal.tokensBaselinePending, false, "estimate written as tokensNow");
  assert.equal(goal.tokensEstimated, true);
  assert.equal(goal.tokensNow - goal.tokensAtStart >= 10, false, "turn 1 = baseline");
  // A second big usage-less turn exceeds the 10-token budget → budget_limited.
  await fire(pi, "agent_end", {
    messages: [{ role: "assistant", content: "z".repeat(400) }],
  });
  assert.equal(machine.get()?.status, "budget_limited");
  assert.equal(machine.get()?.tokensEstimated, true);
  assert.match(pi.sent.at(-1) ?? "", /budget limit/);
  rmSync(dir, { recursive: true, force: true });
});

// ── FIX 5: runaway guard wiring keys on real arguments ───────────────────

function runawayRig() {
  const dir = mkdtempSync(join(tmpdir(), "lh-runaway-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  const pi = fakePi();
  const gate = new Gate({ owner, loadSettings: () => DEFAULT_SETTINGS, env: {} });
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("no verify"); } },
    send: (message) => pi.sendUserMessage(message),
  });
  wireRuntime(pi as never, { machine, toolset, continuation, gate, loadSettings: () => DEFAULT_SETTINGS });
  machine.create("guard", {});
  owner.activate("goal", "guard");
  return { pi, dir };
}

function bashStep(pi: ReturnType<typeof fakePi>, id: string, command: string, result: string, isError = false): void {
  pi.emit("tool_execution_start", { toolCallId: id, toolName: "bash", args: { command } });
  pi.emit("tool_execution_end", { toolCallId: id, toolName: "bash", result, isError });
}

test("three DIFFERENT bash commands never trigger the guard (FIX 5a)", async () => {
  const { pi, dir } = runawayRig();
  bashStep(pi, "1", "npm test", "all green");
  bashStep(pi, "2", "git status", "clean");
  bashStep(pi, "3", "ls src", "a.ts");
  assert.equal(pi.sent.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("the same command three times steers once with the identical-arguments reminder", async () => {
  const { pi, dir } = runawayRig();
  bashStep(pi, "1", "npm test", "fail a", true);
  bashStep(pi, "2", "npm test", "fail b", true);
  bashStep(pi, "3", "npm test", "fail c", true);
  const steers = pi.sent.filter((message) => message.startsWith("No-progress guard:"));
  assert.equal(steers.length, 1);
  assert.match(steers[0] ?? "", /identical arguments/);
  rmSync(dir, { recursive: true, force: true });
});

test("same command and same output yields the identical-results variant, once", async () => {
  const { pi, dir } = runawayRig();
  bashStep(pi, "1", "npm test", "fail", true);
  bashStep(pi, "2", "npm test", "fail", true);
  bashStep(pi, "3", "npm test", "fail", true);
  const steers = pi.sent.filter((message) => message.startsWith("No-progress guard:"));
  assert.equal(steers.length, 1);
  assert.match(steers[0] ?? "", /producing identical results/);
  rmSync(dir, { recursive: true, force: true });
});

test("identical results under DIFFERENT args never match (FIX 5b)", async () => {
  const { pi, dir } = runawayRig();
  bashStep(pi, "1", "cat a.ts", "");
  bashStep(pi, "2", "cat b.ts", "");
  bashStep(pi, "3", "cat c.ts", "");
  assert.equal(pi.sent.length, 0, "empty results from different reads are not a repeat");
  rmSync(dir, { recursive: true, force: true });
});

test("rg no-match exit 1 three times is expected work, not a loop (FIX 5c)", async () => {
  const { pi, dir } = runawayRig();
  bashStep(pi, "1", "rg needle src/", "no matches", true);
  bashStep(pi, "2", "rg needle lib/", "no matches", true);
  bashStep(pi, "3", "rg needle dist/", "no matches", true);
  assert.equal(pi.sent.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("get_goal calls never trigger the guard even when repeated (FIX 5c)", async () => {
  const { pi, dir } = runawayRig();
  for (const id of ["1", "2", "3", "4"]) {
    pi.emit("tool_execution_start", { toolCallId: id, toolName: "get_goal", args: {} });
    pi.emit("tool_execution_end", { toolCallId: id, toolName: "get_goal", result: "{}" });
  }
  assert.equal(pi.sent.length, 0);
  rmSync(dir, { recursive: true, force: true });
});
