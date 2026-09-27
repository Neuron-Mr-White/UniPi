import { strict as assert } from "node:assert";
import { test } from "node:test";
import { longHorizonCompactionBrief } from "../compaction-brief.js";

const goal = (over: Record<string, unknown> = {}) =>
  ({ objective: "Ship the login page with tests", status: "active", turn: 7, maxTurns: 50, noProgressStreak: 0, stallCap: 8, ...over }) as any;

test("active goal: objective, turn and where the durable state lives", () => {
  const brief = longHorizonCompactionBrief(goal(), null, "/state/ralph")!;
  assert.match(brief, /^Goal \(active, turn 7\/50\): "Ship the login page with tests"/);
  assert.match(brief, /get_goal/);
});

test("ralph loop wins over its underlying goal and names the task file", () => {
  const loop = { name: "site", taskFile: "site.md", iteration: 5, maxIterations: 20, status: "active" } as any;
  const brief = longHorizonCompactionBrief(goal(), loop, "/state/ralph")!;
  assert.match(brief, /Ralph loop "site" is running — iteration 5\/20/);
  assert.match(brief, /\/state\/ralph\/site\.md/);
  assert.doesNotMatch(brief, /^Goal/);
});

test("nothing in flight → no brief", () => {
  assert.equal(longHorizonCompactionBrief(null, null, "/x"), null);
  assert.equal(longHorizonCompactionBrief(goal({ status: "paused" }), null, "/x"), null);
});
