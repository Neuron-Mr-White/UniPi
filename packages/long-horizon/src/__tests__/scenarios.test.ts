/**
 * Design §6 scenario matrix — end-to-end sequences over the real engines
 * (fake pi/event transports only; zero network). These are the acceptance
 * narratives for the mode gate: each test drives a multi-turn story.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OwnerCoordinator } from "../owner.js";
import { Gate, filterPayloadTools } from "../gate.js";
import { GoalMachine } from "../engine/goal-state.js";
import { GoalToolset } from "../tools/goal.js";
import { GoalContinuation } from "../engine/continuation.js";
import { RalphLoop } from "../engine/ralph.js";
import { SwarmLedger } from "../tools/swarm.js";
import { GraphLedger } from "../tools/graph.js";
import { wireRuntime } from "../runtime.js";
import { DEFAULT_SETTINGS, type LongHorizonSettings } from "../settings.js";
import type { FetchLike } from "../judge/typesafe.js";

interface World {
  owner: OwnerCoordinator;
  machine: GoalMachine;
  toolset: GoalToolset;
  continuation: GoalContinuation;
  gate: Gate;
  pi: FakePi;
  dir: string;
  judgeOn: (fetch: FetchLike) => void;
}

interface FakePi {
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  sent: string[];
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  sendUserMessage(content: string): void;
  emit(event: string, payload: unknown): void;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi: FakePi = {
    handlers,
    sent: [],
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

function world(settings: LongHorizonSettings = DEFAULT_SETTINGS): World {
  const dir = mkdtempSync(join(tmpdir(), "lh-scenario-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const toolset = new GoalToolset({ machine, owner });
  const pi = fakePi();
  // ONE shared mutable settings object: the gate and runtime must observe
  // judgeOn() flips together.
  const shared: LongHorizonSettings = {
    ...settings,
    // These worlds mock the native /v1/systemone transport; runtime default
    // is "auto" (covered by the provider-auto unit test in judge.test.ts).
    judge: { ...settings.judge, provider: "typesafe" },
  };
  const gate = new Gate({
    owner,
    loadSettings: () => shared,
    env: {},
    // Mirrors index.ts suspendActiveFor: park the owner AND pause engines.
    onExplicitSwitch: (mode) => {
      const active = owner.getActive();
      if (!active) return true;
      if (active.kind === "goal") machine.pause("paused(superseded)");
      return Boolean(owner.suspend(`paused(superseded_by:${mode})`));
    },
  });
  gate.register(pi as never);
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("no verify here"); } },
    send: (message) => pi.sendUserMessage(message),
  });
  wireRuntime(pi as never, {
    machine,
    toolset,
    continuation,
    gate,
    loadSettings: () => shared,
  });
  return {
    owner,
    machine,
    toolset,
    continuation,
    gate,
    pi,
    dir,
    judgeOn: (fetch) => {
      shared.judge = { ...shared.judge, enabled: true };
      (gate as unknown as { deps: { fetchImpl?: FetchLike } }).deps.fetchImpl = fetch;
      (gate as unknown as { deps: { env?: Record<string, string> } }).deps.env = { TYPESAFE_API_KEY: "k" };
    },
  };
}

async function fire(pi: FakePi, event: string, payload: unknown): Promise<void> {
  for (const handler of pi.handlers.get(event) ?? []) await handler(payload, {});
}

const goalPayload = {
  tools: [
    { type: "function", function: { name: "bash" } },
    { type: "function", function: { name: "create_goal" } },
    { type: "function", function: { name: "swarm_status" } },
    { type: "function", function: { name: "spawn_helper" } },
  ],
};

test("scenario 1: judge ON routes a fan-out prompt to swarm and the payload surface follows", async () => {
  const w = world();
  w.judgeOn(async () =>
    new Response(
      JSON.stringify({ answers: { mode: { type: "choice", choice: "swarm", confidence: 0.9 } } }),
      { status: 200 },
    ),
  );
  await fire(w.pi, "before_agent_start", { prompt: "review these six packages in parallel", systemPrompt: "BASE" });
  const state = w.gate.current();
  assert.deepEqual(state?.mode, "swarm");
  assert.equal(state?.source, "judge");
  const filtered = filterPayloadTools(goalPayload, "swarm");
  assert.deepEqual(
    (filtered.tools as Array<{ function?: { name?: string } }>).map((t) => t.function?.name),
    ["bash", "swarm_status", "spawn_helper"], // goal tools hidden, delegation full
  );
  rmSync(w.dir, { recursive: true, force: true });
});

test("scenario 2: explicit /unipi:swarm mid-goal parks the goal; resume restores it", async () => {
  const w = world();
  // Goal active.
  w.machine.create("migrate packages to esm");
  w.owner.activate("goal", "migrate packages to esm");
  await fire(w.pi, "before_agent_start", { prompt: "start migrating", systemPrompt: "BASE" });
  assert.equal(w.gate.current()?.source, "owner");

  // Explicit swarm override parks the goal.
  w.gate.setExplicit("swarm");
  await fire(w.pi, "before_agent_start", { prompt: "review auth modules", systemPrompt: "BASE" });
  assert.equal(w.gate.current()?.mode, "swarm");
  assert.equal(w.owner.getParked()?.kind, "goal");
  assert.equal(w.machine.get()?.status, "paused");

  // Resume: goal reactivates and owns the mode again.
  w.owner.resume();
  w.machine.resume();
  await fire(w.pi, "before_agent_start", { prompt: "continue the migration", systemPrompt: "BASE" });
  assert.deepEqual(w.gate.current(), { mode: "goal", source: "owner" });
  assert.equal(w.machine.get()?.status, "active");
  rmSync(w.dir, { recursive: true, force: true });
});

test("scenario 3: crash → fresh coordinators restore owner + goal; recovery rides the next turn", async () => {
  const w = world();
  w.machine.create("survive crashes", { tokenBudget: null });
  w.owner.activate("goal", "survive crashes");
  await fire(w.pi, "before_agent_start", { prompt: "go", systemPrompt: "BASE" });
  await fire(w.pi, "agent_end", {
    messages: [{ role: "user", content: "go" }, { role: "assistant", content: "starting", usage: { totalTokens: 500 } }],
  });
  assert.equal(w.machine.get()?.kickoffDelivered, true);

  // "Crash": rebuild everything from disk (the real recovery path).
  const revivedOwner = new OwnerCoordinator({ statePath: () => join(w.dir, "owner.json") });
  const revivedMachine = new GoalMachine({ statePath: () => join(w.dir, "goal.json") });
  const restoredOwner = revivedOwner.restore();
  const restoredGoal = revivedMachine.restore();
  assert.equal(restoredOwner?.active?.kind, "goal");
  assert.equal(restoredGoal?.kickoffDelivered, true);
  // Kickoff turn does not settle — the baseline lands on the NEXT turn.
  assert.equal(restoredGoal?.tokensAtStart, 0);
  assert.equal(restoredGoal?.turn, 0);
  rmSync(w.dir, { recursive: true, force: true });
});

test("scenario 4: stale update_goal CAS after suspension is rejected by the tool layer", async () => {
  const w = world();
  const registered: Array<{ name: string; execute: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }) =>
      registered.push({ name: tool.name, execute: (p) => tool.execute("id", p) }),
  } as never;
  w.toolset.register(pi);

  w.machine.create("objective");
  w.owner.activate("goal", "objective");
  const state = JSON.parse(
    (await registered.find((tool) => tool.name === "get_goal")!.execute({})).content[0].text,
  );
  // A legitimate state transition happens between get_goal and update_goal
  // (here: a budget edit landing first) — the captured CAS pair goes stale.
  const update = registered.find((tool) => tool.name === "update_goal")!;
  w.machine.setTokenBudget(9_999);
  const rejected = await update.execute({
    mode: "token_budget",
    token_budget: 50_000,
    expected_goal_id: state.expected_goal_id,
    expected_updated_at: state.expected_updated_at,
  });
  assert.match(rejected.content[0]?.text ?? "", /do not match/);
  rmSync(w.dir, { recursive: true, force: true });
});

test("scenario 5: ralph loop with all items checked verifies, finishes, and emits loop_end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-scenario-ralph-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const events: string[] = [];
  const loop = new RalphLoop({
    machine,
    owner,
    ralphDir: () => join(dir, "ralph"),
    send: () => undefined,
    onEvent: (event) => events.push(event.type),
  });
  loop.setEvaluate(async () => '{"verdict":"met","reason":"every item checked and verified"}');
  loop.start("cleanup", "- [ ] a\n- [ ] b");
  writeFileSync(join(dir, "ralph", "cleanup.md"), "- [x] a\n- [x] b", "utf-8");
  const done = loop.onRalphDone();
  assert.equal(done.ok, true);
  if (done.ok) assert.equal(done.completionClaim, true);
  const verdict = await loop.verifyCompletion();
  assert.deepEqual(verdict, { kind: "met", reason: "every item checked and verified" });
  assert.equal(machine.get()?.status, "complete");
  assert.equal(owner.getActive(), undefined);
  assert.ok(events.includes("loop_start") && events.includes("loop_end"));
  rmSync(dir, { recursive: true, force: true });
});

test("scenario 6: one automation owner — swarm active refuses graph declare and goal create", () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-scenario-one-"));
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const swarm = new SwarmLedger(owner);
  swarm.start("review", [
    { itemId: "a", instruction: "x" },
    { itemId: "b", instruction: "y" },
  ]);
  const graph = new GraphLedger(owner);
  const refused = graph.declare("audit", [{ itemId: "g1", instruction: "z" }]);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.reason, /owned by a swarm owner/);
  rmSync(dir, { recursive: true, force: true });
});

test("scenario 7: budget wrap-up delivered once, owner finished, next plain turn re-resolves to default", async () => {
  const w = world();
  w.machine.create("bounded work", { tokenBudget: 1_000 });
  w.owner.activate("goal", "bounded work");
  let tokens = 100;
  w.continuation.setTokenCounter(() => tokens);
  await fire(w.pi, "agent_end", { messages: [] }); // kickoff (no settle)
  await fire(w.pi, "agent_end", { messages: [] }); // settle 1: baseline lands at 100
  tokens = 100_000;
  await fire(w.pi, "agent_end", { messages: [] }); // settle 2: budget blow-through
  assert.equal(w.machine.get()?.status, "budget_limited");
  assert.equal(w.owner.getActive(), undefined);
  const wrapUps = w.pi.sent.filter((message) => message.includes("budget limit"));
  assert.equal(wrapUps.length, 1);
  // Next user message: no owner → default mode (judge off).
  await fire(w.pi, "before_agent_start", { prompt: "unrelated quick fix", systemPrompt: "BASE" });
  assert.deepEqual(w.gate.current(), { mode: "goal", source: "default" });
  rmSync(w.dir, { recursive: true, force: true });
});
