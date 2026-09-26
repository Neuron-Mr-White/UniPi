import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireConversionLock,
  bodyInvariantOk,
  countFinished,
  planDeleteBatches,
  releaseConversionLock,
} from "../convert.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mem-conv-"));
  fs.mkdirSync(path.join(home, ".unipi", "memory"), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  try { return fn(home); } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("conversion lock: held by a live pid blocks; stale pid is taken", () => {
  withHome((home) => {
    const lock = path.join(home, ".unipi", "memory", ".conversion.lock");
    assert.equal(acquireConversionLock(), true);
    assert.ok(fs.existsSync(lock));
    // A second "process" (live pid=1 → init is alive) is refused.
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: "x" }));
    assert.equal(acquireConversionLock(), false);
    // A dead pid is stale → takeover succeeds.
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22, startedAt: "x" }));
    assert.equal(acquireConversionLock(), true);
    releaseConversionLock();
    assert.ok(!fs.existsSync(lock));
  });
});

test("bodyInvariantOk: non-empty source must produce a non-empty, non-shrinking body", () => {
  assert.equal(bodyInvariantOk(100, 0), false);
  assert.equal(bodyInvariantOk(100, 50), false);
  assert.equal(bodyInvariantOk(100, 100), true);
  assert.equal(bodyInvariantOk(100, 150), true);
  assert.equal(bodyInvariantOk(0, 0), true);
  assert.equal(bodyInvariantOk(undefined, 0), true);
  assert.equal(bodyInvariantOk(-1, 0), false); // hydration expected a body
});

test("planDeleteBatches chunks ids at ≤500 and preserves order", () => {
  const units = [{ drawerIds: ["a", "b"] }, { drawerIds: Array.from({ length: 1200 }, (_, i) => `x${i}`) }, { drawerIds: ["z"] }, {}];
  const batches = planDeleteBatches(units);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 500);
  assert.equal(batches[1].length, 500);
  assert.equal(batches[2].length, 203);
  assert.equal(batches[0][0], "a");
  assert.equal(batches[0][1], "b");
  assert.equal(batches[2].at(-1), "z");
});

test("countFinished: every finished unit counts toward done; failures are separate", () => {
  const units = [
    { deleted: true },                 // had an old drawer, deleted
    { deleted: true },                 // no old drawer — finished outright
    { deleted: true, failed: true },   // failed units never count as done
    { failed: true },                  // verify-failed, never deleted
    {},                                // still pending
  ];
  assert.deepEqual(countFinished(units), { done: 2, failed: 2 });
});
