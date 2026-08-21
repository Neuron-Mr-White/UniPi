/**
 * Scheduled runs tests — ported from pi-subagents scheduled-runs semantics
 * (time parsing, interval parsing, store layout, pause/resume/delete,
 * overlap skip, run-due execution) with OUR ~/.unipi/schedules/ layout.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseScheduledRunTime,
  parseScheduleInterval,
  ScheduledRunManager,
  scheduleStorePath,
} from "../scheduled-runs.js";

const REAL_HOME = process.env.HOME;
let fakeHome: string;
let projectRoot: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "unipi-sched-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "unipi-sched-proj-"));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = REAL_HOME;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("parseScheduledRunTime", () => {
  it("accepts positive relative delays", () => {
    const now = Date.now();
    assert.equal(parseScheduledRunTime("+10m", now), now + 10 * 60_000);
    assert.equal(parseScheduledRunTime("+2h", now), now + 2 * 3_600_000);
    assert.equal(parseScheduledRunTime("+1d", now), now + 86_400_000);
  });

  it("rejects invalid relative delays and past times", () => {
    assert.throws(() => parseScheduledRunTime("+0m"), /must be positive/);
    assert.throws(() => parseScheduledRunTime("-5m"), /Invalid at value/);
    assert.throws(() => parseScheduledRunTime("2020-01-01T00:00:00Z"), /in the past|Invalid at value/);
    assert.throws(() => parseScheduledRunTime("not-a-time"), /Use a one-shot delay/);
  });

  it("accepts ISO timestamps with timezone", () => {
    const future = new Date(Date.now() + 3_600_000);
    const iso = future.toISOString().replace(/\.\d{3}Z$/, "Z");
    assert.equal(parseScheduledRunTime(iso), Date.parse(iso));
  });
});

describe("parseScheduleInterval", () => {
  it("supports m/h/d/w fixed intervals", () => {
    assert.equal(parseScheduleInterval("30m"), 30 * 60_000);
    assert.equal(parseScheduleInterval("6h"), 6 * 3_600_000);
    assert.equal(parseScheduleInterval("2d"), 2 * 86_400_000);
    assert.equal(parseScheduleInterval("2w"), 2 * 604_800_000);
  });

  it("rejects unsupported forms", () => {
    assert.throws(() => parseScheduleInterval("10s"), /fixed intervals/);
    assert.throws(() => parseScheduleInterval("0m"), /must be positive/);
    assert.throws(() => parseScheduleInterval("hourly"), /fixed intervals/);
  });
});

describe("scheduleStorePath", () => {
  it("defaults to ~/.unipi/schedules/<project-hash>/", () => {
    const store = scheduleStorePath(projectRoot);
    assert.ok(store.startsWith(join(fakeHome, ".unipi", "schedules")));
    assert.notEqual(store, join(fakeHome, ".unipi", "schedules"));
  });
});

describe("ScheduledRunManager", () => {
  function makeManager(launchLog: string[], opts: { maxPending?: number } = {}): ScheduledRunManager {
    return new ScheduledRunManager(projectRoot, {
      maxPending: opts.maxPending,
      launch: async (record) => {
        launchLog.push(`${record.agent}:${record.task}`);
        return `async-${launchLog.length}`;
      },
    });
  }

  it("creates one-shot and interval schedules; rejects both/neither", () => {
    const manager = makeManager([]);
    const once = manager.create({ name: "one", agent: "scout", task: "t", at: "+10m" });
    assert.equal(once.trigger.kind, "once");
    const recurring = manager.create({ name: "two", agent: "worker", task: "t", every: "30m" });
    assert.equal(recurring.trigger.kind, "interval");

    assert.throws(
      () => manager.create({ name: "x", agent: "a", task: "t", at: "+5m", every: "5m" }),
      /either.*or.*not both/,
    );
    assert.throws(() => manager.create({ name: "x", agent: "a", task: "t" }), /requires 'at' \(one-shot\) or 'every'/);
    assert.throws(() => manager.create({ name: "", agent: "a", task: "t", at: "+5m" }), /non-empty/);
  });

  it("pause/resume/delete by prefix", () => {
    const manager = makeManager([]);
    const record = manager.create({ name: "mine", agent: "scout", task: "t", every: "1h" });

    assert.equal(manager.setPaused(record.id.slice(0, 8), true).paused, true);
    assert.equal(manager.show(record.id)!.paused, true);
    assert.equal(manager.setPaused(record.id.slice(0, 8), false).paused, false);

    assert.equal(manager.delete(record.id.slice(0, 8)), true);
    assert.equal(manager.show(record.id), undefined);
    assert.equal(manager.delete(record.id), false);
  });

  it("runNow launches and records history with the async run id", async () => {
    const log: string[] = [];
    const manager = makeManager(log);
    const record = manager.create({ name: "now", agent: "reviewer", task: "check", at: "+10m" });
    const run = await manager.runNow(record.id.slice(0, 8));
    assert.equal(run.state, "completed");
    assert.equal(run.asyncRunId, "async-1");
    assert.deepEqual(manager.readHistory(record.id).map((r) => r.asyncRunId), ["async-1"]);
    assert.deepEqual(log, ["reviewer:check"]);
  });

  it("overlap policy skips when a run is active", async () => {
    const log: string[] = [];
    const manager = makeManager(log);
    const record = manager.create({ name: "busy", agent: "worker", task: "t", at: "+10m" });
    // Simulate an active run.
    const shown = manager.show(record.id)!;
    shown.activeRunId = "in-flight";
    manager["save"](shown);

    const run = await manager.runNow(record.id.slice(0, 8));
    assert.equal(run.state, "skipped");
    assert.match(run.error!, /overlap/);
    assert.equal(log.length, 0);
  });

  it("runDue executes only due schedules", async () => {
    const log: string[] = [];
    const manager = makeManager(log);
    // Due one-shot (created in the past via internal manipulation).
    const dueOnce = manager.create({ name: "due", agent: "scout", task: "due-task", at: "+1h" });
    const shown = manager.show(dueOnce.id)!;
    if (shown.trigger.kind === "once") shown.trigger.atMs = Date.now() - 1000;
    manager["save"](shown);
    // Not-due interval.
    manager.create({ name: "later", agent: "worker", task: "later-task", every: "6h" });
    // Paused due.
    const pausedDue = manager.create({ name: "paused-due", agent: "oracle", task: "p", at: "+1h" });
    const pausedShown = manager.show(pausedDue.id)!;
    if (pausedShown.trigger.kind === "once") pausedShown.trigger.atMs = Date.now() - 2000;
    pausedShown.paused = true;
    manager["save"](pausedShown);

    const results = await manager.runDue();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.state, "completed");
    assert.deepEqual(log, ["scout:due-task"]);
  });

  it("failed launches record failed state with error", async () => {
    const manager = new ScheduledRunManager(projectRoot, {
      launch: async () => {
        throw new Error("runner down");
      },
    });
    const record = manager.create({ name: "failing", agent: "scout", task: "t", at: "+10m" });
    const run = await manager.runNow(record.id.slice(0, 8));
    assert.equal(run.state, "failed");
    assert.match(run.error!, /runner down/);
  });
});
