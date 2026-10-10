/**
 * @pi-unipi/dream — schedule + report + approval tests (fixtures only).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_STATE, isDue, isLockLive, type DreamState } from "../src/schedule.ts";
import { DEFAULT_DREAM } from "../src/settings.ts";
import { approveSkill, listProposals, parseReport } from "../src/report.ts";
import { scrub } from "../src/digest.ts";

const SCRIPTS = join(import.meta.dirname, "..", "skills", "craft-skill", "scripts");

const NOW = 1_800_000_000_000;
const fresh: DreamState = { ...EMPTY_STATE, decisions: {} };
/** Dreaming is off by default; the schedule tests are about the "on" case. */
const ON = { ...DEFAULT_DREAM, enabled: true };

describe("schedule", () => {
  it("is due when enough new sessions and the gap passed", () => {
    const r = isDue({ ...fresh, lastRunAt: NOW - 24 * 3600_000, sessionsSeen: 3 }, 9, ON, NOW);
    assert.equal(r.due, true);
  });

  it("is not due before the gap", () => {
    const r = isDue({ ...fresh, lastRunAt: NOW - 3600_000, sessionsSeen: 3 }, 9, ON, NOW);
    assert.equal(r.due, false);
    assert.match(r.reason, /min gap/);
  });

  it("is not due with too few new sessions", () => {
    const r = isDue({ ...fresh, lastRunAt: NOW - 24 * 3600_000, sessionsSeen: 3 }, 6, ON, NOW);
    assert.equal(r.due, false);
    assert.match(r.reason, /more new sessions/);
  });

  it("bootstraps on first run (lastRunAt 0)", () => {
    const r = isDue(fresh, 5, ON, NOW);
    assert.equal(r.due, true);
  });

  it("respects a live lock and expires stale ones", () => {
    assert.equal(isLockLive({ pid: process.pid, at: NOW }), true);
    assert.equal(isLockLive({ pid: process.pid, at: NOW - 3 * 3600_000 }, NOW), false);
    assert.equal(isLockLive({ pid: 999_999, at: NOW }), false);
    assert.equal(isDue({ ...fresh, lock: { pid: process.pid, at: NOW } }, 99, ON, NOW).due, false);
  });

  it("is off by default", () => {
    assert.equal(DEFAULT_DREAM.enabled, false);
    assert.equal(isDue(fresh, 99, DEFAULT_DREAM, NOW).reason, "disabled in settings");
  });

  it("honors disabled setting", () => {
    assert.equal(isDue(fresh, 99, { ...DEFAULT_DREAM, enabled: false }, NOW).due, false);
  });
});

const REPORT_MD = [
  "# DREAM Report",
  "## Memory edits (applied)",
  "- merged duplicates",
  "## Proposals (waiting for approval)",
  "1. **Skill: `unipi-kanboard-writes`** — path proposals/skill-unipi-kanboard-writes/SKILL.md",
  "## Skipped",
  "- one-off",
].join("\n");

function stagingWithProposal(): string {
  const staging = mkdtempSync(join(tmpdir(), "dream-staging-"));
  mkdirSync(join(staging, "proposals", "skill-demo-greet"), { recursive: true });
  writeFileSync(join(staging, "DREAM_REPORT.md"), REPORT_MD);
  writeFileSync(
    join(staging, "proposals", "skill-demo-greet", "SKILL.md"),
    "---\nname: demo-greet\ndescription: Greets people. Use when asked to greet.\n---\n1. Say hi.\n",
  );
  return staging;
}

describe("report + approval", () => {
  let staging: string;
  beforeEach(() => {
    staging = stagingWithProposal();
  });

  it("parses the three report sections", () => {
    const r = parseReport(staging)!;
    assert.match(r.memoryEdits, /merged duplicates/);
    assert.match(r.proposalsSection, /unipi-kanboard-writes/);
    assert.match(r.skipped, /one-off/);
  });

  it("lists skill and check proposals with decisions", () => {
    writeFileSync(join(staging, "proposals", "check-demo.md"), "# check\nbody");
    const ps = listProposals(staging, {});
    assert.equal(ps.length, 2);
    const skill = ps.find((p) => p.kind === "skill")!;
    assert.equal(skill.name, "demo-greet");
    assert.equal(skill.decision, "pending");
    const decided = listProposals(staging, { [skill.id]: "approved" });
    assert.equal(decided.find((p) => p.kind === "skill")!.decision, "approved");
  });

  it("approving a skill copies it into the target and runs the real check script", () => {
    const target = mkdtempSync(join(tmpdir(), "dream-target-"));
    const skill = listProposals(staging, {}).find((p) => p.kind === "skill")!;
    const r = approveSkill(skill, target, SCRIPTS);
    assert.equal(r.ok, true, r.detail);
    const copied = readFileSync(join(r.target!, "SKILL.md"), "utf8");
    assert.match(copied, /demo-greet/);
  });

  it("approval fails when the check script fails (secret outside .env)", () => {
    const target = mkdtempSync(join(tmpdir(), "dream-target-"));
    const skill = listProposals(staging, {}).find((p) => p.kind === "skill")!;
    writeFileSync(join(skill.path, "leak.md"), "token sk-abcdefghij0123456789 hardcoded\n");
    const r = approveSkill(skill, target, SCRIPTS);
    assert.equal(r.ok, false);
    assert.match(r.detail, /FAIL/);
  });
});
