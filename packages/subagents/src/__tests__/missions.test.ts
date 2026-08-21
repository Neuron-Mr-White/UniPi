/**
 * Mission store + workflow state tests — ported from pi-subagents missions
 * semantics (OUR layout: ~/.unipi/missions/<project-hash>/ via HOME override).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveMissionStoreLocation,
  createMission,
  readMission,
  listMissions,
  updateMission,
  MissionNotFoundError,
  projectHashKey,
  validateMissionId,
  parseMissionRecord,
} from "../mission-store.js";
import { createMissionWorkflowState, MISSION_STATE_MAX_BYTES } from "../mission-state.js";
import { handleSpawnHelper, type HandlerDeps } from "../tool-handler.js";
import { AgentManager } from "../agent-manager.js";

let fakeHome: string;
let projectRoot: string;
const REAL_HOME = process.env.HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "unipi-missions-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "unipi-missions-proj-"));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = REAL_HOME;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

function location() {
  return resolveMissionStoreLocation({ projectRoot });
}

describe("store location", () => {
  it("resolves to ~/.unipi/missions/<project-hash>/", () => {
    const loc = location();
    assert.equal(loc.missionDir, join(fakeHome, ".unipi", "missions", projectHashKey(projectRoot)));
    assert.equal(loc.globalIndexDir, join(fakeHome, ".unipi", "missions", "index"));
    assert.equal(loc.writeGlobalIndex, true);
  });

  it("projectHashKey is stable and root-specific", () => {
    assert.equal(projectHashKey(projectRoot), projectHashKey(projectRoot));
    assert.notEqual(projectHashKey(projectRoot), projectHashKey("/other"));
  });
});

describe("mission CRUD", () => {
  it("creates, reads, lists, updates", () => {
    const created = createMission(location(), { title: "Ship parity", objective: "Finish phases" });
    assert.match(created.id, /^[A-Za-z0-9]/);
    assert.equal(created.status, "planned");

    const read = readMission(location(), created.id);
    assert.equal(read.title, "Ship parity");

    const updated = updateMission(location(), created.id, {
      status: "active",
      addRun: { runId: "run-1", agent: "worker" },
      addDecision: { title: "Use hybrid arch?" },
      incrementUsage: { tokens: 500 },
    });
    assert.equal(updated.status, "active");
    assert.equal(updated.runs.length, 1);
    assert.equal(updated.decisions.length, 1);
    assert.equal(updated.decisions[0]!.status, "open");
    assert.equal(updated.usage?.tokens, 500);

    const listed = listMissions(location());
    assert.equal(listed.records.length, 1);
  });

  it("goal budget exhaustion flips the goal status", () => {
    const created = createMission(location(), { title: "T", objective: "O", goal: true, budget: { tokens: 100 } });
    const updated = updateMission(location(), created.id, { incrementUsage: { tokens: 100 } });
    assert.equal(updated.goal!.status, "budget-exhausted");
  });

  it("goal without budget throws", () => {
    assert.throws(
      () => createMission(location(), { title: "T", objective: "O", goal: true }),
      /budget is required when mission.goal is true/,
    );
  });

  it("resolveDecision closes an open decision", () => {
    const created = createMission(location(), { title: "T", objective: "O" });
    const withDecision = updateMission(location(), created.id, { addDecision: { title: "Pick one" } });
    const decisionId = withDecision.decisions[0]!.id;
    const resolved = updateMission(location(), created.id, {
      resolveDecision: { id: decisionId, resolution: "hybrid" },
    });
    assert.equal(resolved.decisions[0]!.status, "resolved");
    assert.equal(resolved.decisions[0]!.resolution, "hybrid");
  });

  it("retainTerminal prunes only the oldest terminal records", () => {
    const loc = { ...location(), retainTerminal: 2 };
    for (let i = 0; i < 4; i++) {
      const m = createMission(loc, { title: `M${i}`, objective: "O" }, new Date(Date.now() + i * 1000));
      updateMission(loc, m.id, { status: "completed" }, new Date(Date.now() + i * 1000 + 500));
    }
    const listed = listMissions(loc);
    assert.equal(listed.records.length, 2);
  });

  it("missing mission throws MissionNotFoundError", () => {
    assert.throws(() => readMission(location(), "a0000000"), MissionNotFoundError);
  });

  it("global index pointer written; corrupt records listed with warnings", () => {
    const created = createMission(location(), { title: "Indexed", objective: "O" });
    const loc = location();
    assert.ok(existsSync(join(loc.globalIndexDir)));

    // Corrupt one record file
    const recordPath = join(loc.missionDir, `${created.id}.json`);
    writeFileSync(recordPath, "{broken");
    const listed = listMissions(loc);
    assert.equal(listed.warnings.length, 1);
  });

  it("validateMissionId + parseMissionRecord reject garbage", () => {
    assert.throws(() => validateMissionId("../evil"), /must be 1-128 characters/);
    assert.throws(() => parseMissionRecord({ schemaVersion: 2 }), /schemaVersion must be 1/);
  });
});

describe("mission workflow state", () => {
  it("get/set with lock + 256KiB cap", () => {
    const created = createMission(location(), { title: "T", objective: "O" });
    const state = createMissionWorkflowState(location().missionDir, created.id);

    assert.equal(state.get("missing"), undefined);
    state.set("seed", { count: 1 });
    assert.deepEqual(state.get("seed"), { count: 1 });
    state.set("seed", { count: 2 });
    assert.deepEqual(state.get("seed"), { count: 2 });

    assert.throws(() => state.set("bad key!", 1), /state key must be/);
    assert.throws(() => state.set("big", "x".repeat(MISSION_STATE_MAX_BYTES + 1)), /byte limit/);
  });

  it("state persists across adapter instances (shared via missionId)", () => {
    const created = createMission(location(), { title: "T", objective: "O" });
    createMissionWorkflowState(location().missionDir, created.id).set("k", "v1");
    const again = createMissionWorkflowState(location().missionDir, created.id);
    assert.equal(again.get("k"), "v1");
  });
});

describe("handler mission actions", () => {
  function makeDeps(): HandlerDeps {
    return {
      pi: {} as never,
      manager: new AgentManager(undefined, 4, undefined, {}, "/tmp", { user: {}, project: {} }),
      config: { maxConcurrent: 4, enabled: true, types: {} },
      spawnForeground: async (_c, agent) => ({ ok: true, output: `ran ${agent}`, toolUses: 1, durationMs: 5 }),
      spawnBackground: () => "id",
      env: {},
      projectRoot,
    };
  }
  const ctx = {} as never;

  it("mission.create/list/show/close round-trip through the handler", async () => {
    const deps = makeDeps();
    const created = await handleSpawnHelper(deps, ctx, {
      action: "mission.create",
      mission: { title: "Handler mission", objective: "Test it" },
    });
    assert.match(created.content[0]!.text, /Mission created/);
    const missionId = (created.details as { missionId: string }).missionId;

    const listed = await handleSpawnHelper(deps, ctx, { action: "mission.list" });
    assert.match(listed.content[0]!.text, /Handler mission/);

    const shown = await handleSpawnHelper(deps, ctx, { action: "mission.show", missionId });
    assert.match(shown.content[0]!.text, /Title: Handler mission/);

    const closed = await handleSpawnHelper(deps, ctx, {
      action: "mission.close",
      missionId,
      summary: "done",
    });
    assert.match(closed.content[0]!.text, /closed as completed/);
    deps.manager.dispose();
  });

  it("mission.attach-run + resolve-decision", async () => {
    const deps = makeDeps();
    const created = await handleSpawnHelper(deps, ctx, {
      action: "mission.create",
      mission: { title: "Attach test", objective: "O" },
    });
    const missionId = (created.details as { missionId: string }).missionId;

    const attached = await handleSpawnHelper(deps, ctx, {
      action: "mission.attach-run", missionId, runId: "run-77",
    });
    assert.match(attached.content[0]!.text, /Run run-77 attached/);

    const shown = await handleSpawnHelper(deps, ctx, { action: "mission.show", missionId });
    assert.match(shown.content[0]!.text, /run-77/);
    deps.manager.dispose();
  });
});
