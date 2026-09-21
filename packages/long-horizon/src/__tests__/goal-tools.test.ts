import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoalMachine } from "../engine/goal-state.js";
import { GoalToolset } from "../tools/goal.js";
import { OwnerCoordinator } from "../owner.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "lh-goaltools-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const toolset = new GoalToolset({ machine, owner });
  return { machine, owner, toolset, dir };
}

/** Tools execute with a stub pi that just records registrations. */
function register(toolset: GoalToolset) {
  const registered: Array<{ name: string; execute: (p: unknown) => Promise<string> }> = [];
  const pi = {
    registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }) => {
      registered.push({
        name: tool.name,
        execute: async (p) => (await tool.execute("id", p)).content[0]?.text ?? "",
      });
    },
  } as never;
  toolset.register(pi);
  const byName = (name: string) => {
    const tool = registered.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.execute;
  };
  return { byName };
}

test("create → get → CAS update flow", async () => {
  const { machine, owner, toolset, dir } = harness();
  const { byName } = register(toolset);

  const created = await byName("create_goal")({ objective: "all tests pass", token_budget: 50000 });
  assert.match(created, /Goal set: "all tests pass"/);
  assert.match(created, /budget 50000 tokens/);
  assert.equal(owner.getActive()?.kind, "goal"); // owner activated

  const state = JSON.parse(await byName("get_goal")({})) as Record<string, unknown>;
  assert.equal(state.status, "active");
  assert.equal(state.goal_id, machine.get()?.goalId);

  // Fresh CAS pair → budget update accepted.
  const updated = await byName("update_goal")({
    mode: "token_budget",
    token_budget: 60000,
    expected_goal_id: state.expected_goal_id,
    expected_updated_at: state.expected_updated_at,
  });
  assert.match(updated, /Token budget set to 60000/);
  assert.equal(machine.get()?.tokenBudget, 60000);

  // Stale CAS pair → rejected, budget unchanged.
  const stale = await byName("update_goal")({
    mode: "token_budget",
    token_budget: 10,
    expected_goal_id: state.expected_goal_id,
    expected_updated_at: state.expected_updated_at,
  });
  assert.match(stale, /do not match/);
  assert.equal(machine.get()?.tokenBudget, 60000);

  rmSync(dir, { recursive: true, force: true });
});

test("create_goal rejected while a goal is parked or unfinished", async () => {
  const { machine, toolset, dir } = harness();
  const { byName } = register(toolset);
  await byName("create_goal")({ objective: "first goal" });
  machine.pause("paused(superseded)");

  const parked = await byName("create_goal")({ objective: "second goal" });
  assert.match(parked, /parked goal exists/);
  assert.match(parked, /\/unipi:goal resume or \/unipi:goal clear/);

  machine.resume();
  const unfinished = await byName("create_goal")({ objective: "another" });
  assert.match(unfinished, /unfinished goal/);
  rmSync(dir, { recursive: true, force: true });
});

test("status proposal is pending, never settles the goal", async () => {
  const { machine, toolset, dir } = harness();
  const { byName } = register(toolset);
  await byName("create_goal")({ objective: "objective" });

  const proposed = await byName("update_goal")({ mode: "status", status: "complete", summary: "tests pass" });
  assert.match(proposed, /Completion proposed/);
  assert.match(proposed, /independent verifier/);
  assert.equal(machine.get()?.status, "active"); // not complete

  const claim = toolset.peekProposal();
  assert.equal(claim?.kind, "completion");
  assert.equal(claim?.summary, "tests pass");

  // Second proposal same turn rejected.
  const dup = await byName("update_goal")({ mode: "status", status: "blocked" });
  assert.match(dup, /already pending/);

  // Drain works once.
  const drained = toolset.consumeProposal();
  assert.ok(drained);
  assert.equal(toolset.consumeProposal(), null);
  rmSync(dir, { recursive: true, force: true });
});

test("blocked proposals carry safety flag; one-per-turn enforced", async () => {
  const { toolset, dir } = harness();
  const { byName } = register(toolset);
  await byName("create_goal")({ objective: "objective" });

  const blocked = await byName("update_goal")({
    mode: "status",
    status: "blocked",
    summary: "needs user input",
    safety_refusal: true,
  });
  assert.match(blocked, /Safety refusal recorded/);
  assert.equal(toolset.peekProposal()?.safetyRefusal, true);
  rmSync(dir, { recursive: true, force: true });
});

test("get_goal with no goal and update without goal are graceful", async () => {
  const { toolset, dir } = harness();
  const { byName } = register(toolset);
  assert.match(await byName("get_goal")({}), /No goal exists/);
  assert.match(await byName("update_goal")({ mode: "status", status: "complete" }), /No goal to update/);
  rmSync(dir, { recursive: true, force: true });
});
