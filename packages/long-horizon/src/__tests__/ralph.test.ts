import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  RalphLoop,
  parseChecklist,
  nextUnchecked,
  RALPH_COMPLETE_MARKER,
} from "../engine/ralph.js";
import { GoalMachine } from "../engine/goal-state.js";
import { OwnerCoordinator } from "../owner.js";
import { registerRalphTools } from "../tools/ralph.js";
import { normalizeTodoItem, renderTodoLine, validateTodoList, TodoStore } from "../tools/todo.js";

// ── todowrite ────────────────────────────────────────────────────────────

test("normalizeTodoItem repairs and rejects", () => {
  assert.deepEqual(normalizeTodoItem({ content: "  fix bug ", status: "pending", priority: "bogus" }), {
    content: "fix bug",
    status: "pending",
    priority: "medium",
  });
  assert.ok("error" in normalizeTodoItem({ content: "", status: "pending" }));
  assert.ok("error" in normalizeTodoItem({ content: "x", status: "weird" }));
});

test("validateTodoList enforces one in_progress and a size cap", () => {
  const item = (status: string) => ({ content: "x", status, priority: "low" });
  assert.equal(validateTodoList([item("in_progress"), item("in_progress")]).kind, "rejected");
  assert.equal(validateTodoList([item("in_progress"), item("pending")]).kind, "ok");
  const many = Array.from({ length: 51 }, () => item("pending"));
  assert.equal(validateTodoList(many).kind, "rejected");
});

test("TodoStore write + renderTodoLine", () => {
  const store = new TodoStore();
  const result = store.write([
    { content: "scan", status: "completed", priority: "high" },
    { content: "patch the parser", status: "in_progress", priority: "high" },
    { content: "ship", status: "pending", priority: "medium" },
  ]);
  assert.equal(result.kind, "ok");
  assert.equal(renderTodoLine(store.get()), "1/3 · ▶ patch the parser");
  const rejected = store.write([{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }]);
  assert.equal(rejected.kind, "rejected");
  // Rejected write leaves the previous list intact.
  assert.equal(store.get().length, 3);
});

// ── ralph checklist parsing ──────────────────────────────────────────────

test("parseChecklist extracts checked state across formats", () => {
  const items = parseChecklist(
    "# Title\n- [ ] alpha\n* [x] beta\n  - [X] gamma\n- [ ]delta\nnot a task\n- [x] ",
  );
  assert.deepEqual(
    items.map((i) => [i.checked, i.text]),
    [
      [false, "alpha"],
      [true, "beta"],
      [true, "gamma"],
      [false, "delta"],
      [true, ""],
    ],
  );
});

test("nextUnchecked honors the per-iteration cap", () => {
  const items = parseChecklist("- [x] done\n- [ ] a\n- [ ] b\n- [ ] c");
  assert.deepEqual(
    nextUnchecked(items, 2).map((i) => i.text),
    ["a", "b"],
  );
  assert.equal(nextUnchecked(items, 0).length, 3);
});

// ── RalphLoop lifecycle ──────────────────────────────────────────────────

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "lh-ralph-"));
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const sent: string[] = [];
  const loop = new RalphLoop({
    machine,
    owner,
    ralphDir: () => join(dir, "ralph"),
    send: (message) => sent.push(message),
  });
  return { loop, machine, owner, sent, dir };
}

test("start writes files, activates the owner, delivers iteration 1", () => {
  const { loop, owner, sent, dir } = rig();
  const result = loop.start("my loop", "# Tasks\n- [ ] one\n- [ ] two\n- [ ] three", {
    itemsPerIteration: 2,
  });
  assert.equal(result.ok, true);
  assert.equal(owner.getActive()?.kind, "ralph-loop");
  assert.match(sent[0] ?? "", /RALPH LOOP: my-loop \| Iteration 1/);
  assert.match(sent[0] ?? "", /- \[ \] one/);
  assert.match(sent[0] ?? "", /- \[ \] two/);
  assert.ok(!/\[ \] three/.test((sent[0] ?? "").split("Instructions")[0] ?? ""));
  assert.equal(loop.get()?.goalId, undefined ?? loop.get()?.goalId); // state exists
  assert.ok(loop.get());
  rmSync(dir, { recursive: true, force: true });
});

test("start refuses without checklist items and with a foreign owner", () => {
  const { loop, owner, dir } = rig();
  const noItems = loop.start("empty", "just prose, no boxes");
  assert.equal(noItems.ok, false);
  if (!noItems.ok) assert.match(noItems.reason, /no checklist items/);

  owner.activate("goal", "busy");
  const owned = loop.start("second", "- [ ] x");
  assert.equal(owned.ok, false);
  if (!owned.ok) assert.match(owned.reason, /owned by a goal owner/);
  rmSync(dir, { recursive: true, force: true });
});

test("onRalphDone advances iterations and re-reads the task file", () => {
  const { loop, dir, sent } = rig();
  loop.start("loop", "- [ ] a\n- [ ] b\n- [ ] c", { itemsPerIteration: 1 });
  const first = sent.length;

  // Simulate the agent checking an item.
  const taskFile = join(dir, "ralph", "loop.md");
  writeFileSync(taskFile, "- [x] a\n- [ ] b\n- [ ] c", "utf-8");

  const done = loop.onRalphDone();
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.ok(done.prompt);
    assert.match(done.prompt ?? "", /Iteration 2/);
    assert.match(done.prompt ?? "", /1\/3 done/);
    assert.match(done.prompt ?? "", /- \[ \] b/); // next unchecked
  }
  assert.equal(sent.length, first + 1);
  rmSync(dir, { recursive: true, force: true });
});

test("all items checked → completion claim instead of next iteration", () => {
  const { loop, dir, sent } = rig();
  loop.start("loop", "- [ ] a", { itemsPerIteration: 1 });
  writeFileSync(join(dir, "ralph", "loop.md"), "- [x] a", "utf-8");
  const done = loop.onRalphDone();
  assert.equal(done.ok, true);
  if (done.ok) {
    assert.equal(done.completionClaim, true);
    assert.equal(done.prompt, undefined);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("reflection cadence rides every Nth iteration", () => {
  const { loop, dir, sent } = rig();
  loop.start("loop", "- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e", {
    itemsPerIteration: 1,
    reflectEvery: 2,
  });
  const taskFile = join(dir, "ralph", "loop.md");
  writeFileSync(taskFile, "- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n- [ ] e", "utf-8");
  loop.onRalphDone(); // → iteration 2 = reflection
  const last = sent.at(-1) ?? "";
  assert.match(last, /REFLECTION/);
  rmSync(dir, { recursive: true, force: true });
});

test("restore reloads loop state from disk (migration path)", () => {
  const { loop, dir } = rig();
  loop.start("legacy", "- [ ] a");
  const revived = new RalphLoop({
    machine: new GoalMachine({ statePath: () => join(dir, "goal.json") }),
    owner: new OwnerCoordinator({ statePath: () => join(dir, "owner.json") }),
    ralphDir: () => join(dir, "ralph"),
    send: () => undefined,
  });
  const restored = revived.restore("legacy");
  assert.equal(restored?.name, "legacy");
  assert.equal(restored?.iteration, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── UNI-283: restart restore + real task-file path ───────────────────────

function revive(dir: string) {
  const machine = new GoalMachine({ statePath: () => join(dir, "goal.json") });
  const owner = new OwnerCoordinator({ statePath: () => join(dir, "owner.json") });
  const sent: string[] = [];
  const loop = new RalphLoop({ machine, owner, ralphDir: () => join(dir, "ralph"), send: (m) => sent.push(m) });
  // Same order as index.ts session_start.
  owner.restore();
  machine.restore();
  return { machine, owner, loop, sent };
}

test("restoreFromOwner: after a restart ralph_done works again (no 'no active loop')", () => {
  const { loop, dir } = rig();
  loop.start("my loop", "- [ ] a\n- [ ] b", { itemsPerIteration: 1 });
  writeFileSync(join(dir, "ralph", "my-loop.md"), "- [x] a\n- [ ] b", "utf-8");

  const after = revive(dir);
  assert.equal(after.loop.get(), null, "pre-fix: nothing restored");
  const result = after.loop.restoreFromOwner();
  assert.equal(result.kind, "restored");
  assert.equal(after.loop.get()?.name, "my-loop");
  assert.equal(after.loop.get()?.goalId, after.machine.get()?.goalId, "loop, goal and owner agree");
  assert.equal(after.owner.getActive()?.kind, "ralph-loop");
  const done = after.loop.onRalphDone();
  assert.equal(done.ok, true);
  if (done.ok) assert.match(done.prompt ?? "", /Iteration 2/);
  rmSync(dir, { recursive: true, force: true });
});

test("restoreFromOwner: a parked ralph owner restores the loop too (resume works)", () => {
  const { loop, owner, dir } = rig();
  loop.start("parked", "- [ ] a");
  owner.suspend("paused(user_requested)");
  const after = revive(dir);
  assert.equal(after.loop.restoreFromOwner().kind, "restored");
  assert.equal(after.owner.getParked()?.kind, "ralph-loop");
  rmSync(dir, { recursive: true, force: true });
});

test("restoreFromOwner: orphaned ralph owner (loop file gone / goal finished) is retired", () => {
  const { loop, machine, dir } = rig();
  loop.start("gone", "- [ ] a");
  rmSync(join(dir, "ralph", "gone.state.json"));
  let after = revive(dir);
  assert.deepEqual(after.loop.restoreFromOwner(), { kind: "orphaned", reason: "loop state missing" });
  assert.equal(after.owner.getActive(), undefined, "the slot is freed, not wedged");
  assert.equal(after.loop.get(), null);

  // Goal already terminal while the owner was still recorded active.
  const second = rig();
  second.loop.start("done", "- [ ] a");
  second.machine.clear();
  after = revive(second.dir);
  assert.deepEqual(after.loop.restoreFromOwner(), { kind: "orphaned", reason: "loop goal complete" });
  assert.equal(after.owner.getActive(), undefined);
  void machine;
  rmSync(dir, { recursive: true, force: true });
  rmSync(second.dir, { recursive: true, force: true });
});

test("restoreFromOwner: no ralph owner → no loop (a goal owner never adopts loop files)", () => {
  const { loop, owner, dir } = rig();
  loop.start("x", "- [ ] a");
  owner.finish("stopped(user_requested)");
  owner.activate("goal", "other");
  const after = revive(dir);
  assert.deepEqual(after.loop.restoreFromOwner(), { kind: "none" });
  assert.equal(after.loop.get(), null);
  rmSync(dir, { recursive: true, force: true });
});

test("model-facing task-file path is the real ralphDir path, not .unipi/ralph", () => {
  const { loop, machine, sent, dir } = rig();
  loop.start("Path Check", "- [ ] a\n- [ ] b", { itemsPerIteration: 1 });
  const real = join(dir, "ralph", "path-check.md");
  assert.equal(loop.taskFilePath("Path Check"), real);
  assert.ok((sent[0] ?? "").includes(`Task file: ${real} `), "iteration prompt names the real file");
  assert.ok(!(sent[0] ?? "").includes(".unipi/ralph"));
  assert.ok(machine.get()?.objective.includes(real), "goal objective (verifier input) names the real file");
  rmSync(dir, { recursive: true, force: true });
});

test("loop_status tool reports the real task-file path", async () => {
  const { loop, dir } = rig();
  loop.start("tool path", "- [ ] a");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  registerRalphTools({ registerTool: (tool: never) => tools.push(tool) } as never, loop);
  const status = await tools.find((t) => t.name === "loop_status")!.execute("id", {});
  const parsed = JSON.parse(status.content[0]!.text);
  assert.equal(parsed.task_file, join(dir, "ralph", "tool-path.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("ralph iteration prompts are persisted as the goal's pending continuation", () => {
  const { loop, machine, sent, dir } = rig();
  loop.start("outbox", "- [ ] a\n- [ ] b", { itemsPerIteration: 1 });
  assert.equal(machine.get()?.pendingContinuation?.text, sent[0]);
  writeFileSync(join(dir, "ralph", "outbox.md"), "- [x] a\n- [ ] b", "utf-8");
  loop.onRalphDone();
  assert.equal(machine.get()?.pendingContinuation?.text, sent.at(-1));
  rmSync(dir, { recursive: true, force: true });
});
