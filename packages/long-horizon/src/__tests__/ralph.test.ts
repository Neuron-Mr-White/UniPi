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
