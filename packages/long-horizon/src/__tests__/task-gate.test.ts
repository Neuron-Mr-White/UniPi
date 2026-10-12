import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attachTaskReminder,
  DEFAULT_TASK_REMINDERS_PER_GOAL,
  GoalTaskGatePolicy,
  TASK_GATE_REMINDER,
  TASK_REMINDER_MAX_ITEMS,
  renderTaskReminder,
} from "../engine/task-gate.js";

test("planAdmission: no tasks → no_actionable_tasks; tasks → reminder_injected", () => {
  let tasks: string[] = [];
  const gate = new GoalTaskGatePolicy({ listActionableTasks: () => tasks });
  assert.deepEqual(gate.planAdmission("g1"), { tasks: [], decision: "no_actionable_tasks" });
  tasks = ["a", "b"];
  const plan = gate.planAdmission("g1");
  assert.equal(plan.decision, "reminder_injected");
  assert.ok(plan.reminder?.startsWith(TASK_GATE_REMINDER));
});

test("reminder budget is per goal and only spent by markStarted (Maka)", () => {
  const gate = new GoalTaskGatePolicy({ listActionableTasks: () => ["x"] });
  for (let i = 0; i < DEFAULT_TASK_REMINDERS_PER_GOAL; i++) {
    const plan = gate.planAdmission("g1");
    assert.equal(plan.decision, "reminder_injected");
    // Planning alone doesn't spend the budget.
    assert.equal(gate.planAdmission("g1").decision, "reminder_injected");
    gate.markStarted("g1", plan);
  }
  assert.equal(gate.planAdmission("g1").decision, "reminder_limit_reached");
  assert.equal(gate.planAdmission("g2").decision, "reminder_injected", "a new goal gets a fresh budget");
});

test("configurable budget; a throwing source and no deps are treated as no tasks", () => {
  const once = new GoalTaskGatePolicy({ listActionableTasks: () => ["x"], maxRemindersPerGoal: 1 });
  once.markStarted("g", once.planAdmission("g"));
  assert.equal(once.planAdmission("g").decision, "reminder_limit_reached");
  const broken = new GoalTaskGatePolicy({ listActionableTasks: () => { throw new Error("boom"); } });
  assert.equal(broken.planAdmission("g").decision, "no_actionable_tasks");
  assert.equal(new GoalTaskGatePolicy(undefined).planAdmission("g").decision, "no_actionable_tasks");
});

test("renderTaskReminder is bounded (item count and length)", () => {
  const many = Array.from({ length: 15 }, (_, i) => `task ${i} ${"x".repeat(300)}`);
  const text = renderTaskReminder(many);
  const lines = text.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, TASK_REMINDER_MAX_ITEMS + 1);
  assert.match(lines.at(-1) ?? "", /and 5 more/);
  assert.ok(lines.every((line) => line.length <= 125));
});

test("attachTaskReminder inserts before the Evaluation/Goal lines, else appends", () => {
  assert.equal(attachTaskReminder("pre\nEvaluation: e\nGoal: g", "R"), "pre\n\nR\nEvaluation: e\nGoal: g");
  assert.equal(attachTaskReminder("pre\nGoal: g", "R"), "pre\n\nR\nGoal: g");
  assert.equal(attachTaskReminder("plain", "R"), "plain\n\nR");
  assert.equal(attachTaskReminder("plain", undefined), "plain");
});
