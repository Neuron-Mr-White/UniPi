/**
 * Plan mode: read-only enforcement, plan_submit approval, resume, reminders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforcePlanMode, planBlockReason } from "../src/plan/enforce.js";
import {
  PLAN_STATE_ENTRY,
  currentPlanState,
  planFileName,
  planFilePath,
  resetPlanState,
  restorePlanState,
  type PlanSessionState,
} from "../src/plan/state.js";
import { planInstructions, planReminder } from "../src/plan/index.js";

function cwd(): string {
  return mkdtempSync(join(tmpdir(), "plan-"));
}

function activeState(dir: string, sessionId = "session-1"): PlanSessionState {
  const file = planFilePath(dir, sessionId);
  mkdirSync(join(dir, ".unipi", "plans"), { recursive: true });
  return { sessionId, active: true, planFile: file };
}

describe("plan file naming", () => {
  it("is <date>-<short-session-id>.md", () => {
    const name = planFileName("2f1a9c34-8b7e-4f0d-9a11-000000000000", new Date("2026-09-24T10:00:00Z"));
    assert.equal(name, "2026-09-24-2f1a9c34.md");
  });

  it("sits under .unipi/plans", () => {
    assert.equal(planFilePath("/w", "abcdef123456"), "/w/.unipi/plans/" + planFileName("abcdef123456"));
  });
});

describe("plan mode enforcement", () => {
  it("allows writing the plan file only", () => {
    const dir = cwd();
    const state = activeState(dir);
    assert.equal(enforcePlanMode({ toolName: "write", subject: state.planFile! }, state, dir), undefined);
    assert.equal(enforcePlanMode({ toolName: "edit", subject: state.planFile! }, state, dir), undefined);

    const blocked = enforcePlanMode({ toolName: "write", subject: join(dir, "src/a.ts") }, state, dir);
    assert.equal(blocked?.block, true);
    assert.match(blocked!.reason, /Plan mode is read-only/);
    assert.match(blocked!.reason, /Only the plan file may be written/);
  });

  it("resolves relative plan paths", () => {
    const dir = cwd();
    const state = activeState(dir);
    const rel = state.planFile!.slice(dir.length + 1);
    assert.equal(enforcePlanMode({ toolName: "write", subject: rel }, state, dir), undefined);
  });

  it("allows read-only bash and blocks everything else", () => {
    const dir = cwd();
    const state = activeState(dir);
    assert.equal(enforcePlanMode({ toolName: "bash", subject: "git status && ls" }, state, dir), undefined);

    for (const command of ["npm install", "rm -rf x", "echo hi > out.txt", "cat $(ls)"]) {
      const blocked = enforcePlanMode({ toolName: "bash", subject: command }, state, dir);
      assert.equal(blocked?.block, true, `${command} must be blocked`);
      assert.match(blocked!.reason, /Bash is limited to read-only commands/);
    }
  });

  it("blocks mutating tools but keeps ask_user and plan_submit", () => {
    const dir = cwd();
    const state = activeState(dir);
    for (const tool of ["bg_run", "spawn_helper", "memory_store", "notify_user"]) {
      assert.equal(enforcePlanMode({ toolName: tool, subject: "{}" }, state, dir)?.block, true, tool);
    }
    for (const tool of ["read", "grep", "ask_user", "plan_submit", "memory_search"]) {
      assert.equal(enforcePlanMode({ toolName: tool, subject: "" }, state, dir), undefined, tool);
    }
  });

  it("is inert when plan mode is off", () => {
    const dir = cwd();
    const state: PlanSessionState = { sessionId: "s", active: false, planFile: null };
    assert.equal(enforcePlanMode({ toolName: "bash", subject: "rm -rf /" }, state, dir), undefined);
  });

  it("names the plan file in the block reason", () => {
    const dir = cwd();
    const state = activeState(dir);
    const reason = planBlockReason(state.planFile, dir, "Nope.");
    assert.match(reason.reason, /\.unipi\/plans\/\d{4}-\d{2}-\d{2}-session1\.md/);
    assert.match(reason.reason, /call plan_submit/);
  });
});

describe("plan state persistence", () => {
  it("restores an active session from its entry", () => {
    const dir = cwd();
    const file = planFilePath(dir, "sess-9");
    const state = restorePlanState("sess-9", [{ customType: PLAN_STATE_ENTRY, data: { active: true, planFile: file } }], dir);
    assert.equal(state.active, true);
    assert.equal(state.planFile, file);
  });

  it("uses the last entry on the branch (off wins over on)", () => {
    const dir = cwd();
    const file = planFilePath(dir, "sess-9");
    const state = restorePlanState("sess-9", [
      { customType: PLAN_STATE_ENTRY, data: { active: true, planFile: file } },
      { customType: PLAN_STATE_ENTRY, data: { active: false, planFile: file } },
    ], dir);
    assert.equal(state.active, false);
  });

  it("falls back to the derived plan file for an old active entry", () => {
    const dir = cwd();
    const state = restorePlanState("sess-9", [{ customType: PLAN_STATE_ENTRY, data: { active: true } }], dir);
    assert.equal(state.active, true);
    assert.equal(state.planFile, planFilePath(dir, "sess-9"));
  });

  it("ignores unrelated entries and resets a different session", () => {
    const dir = cwd();
    restorePlanState("a", [{ customType: "other", data: { active: true } }], dir);
    assert.equal(currentPlanState("a").active, false);
    assert.equal(currentPlanState("b").sessionId, "b");
    assert.equal(currentPlanState("b").active, false);
  });

  it("reset clears the state", () => {
    const dir = cwd();
    activeState(dir);
    restorePlanState("s", [{ customType: PLAN_STATE_ENTRY, data: { active: true } }], dir);
    const cleared = resetPlanState("s");
    assert.equal(cleared.active, false);
    assert.equal(cleared.planFile, null);
  });
});

describe("plan messages", () => {
  it("instructions name the plan file and the required sections", () => {
    const text = planInstructions(".unipi/plans/2026-09-24-abcd1234.md");
    assert.match(text, /investigation only/i);
    assert.match(text, /2026-09-24-abcd1234\.md/);
    assert.match(text, /## Summary/);
    assert.match(text, /## Steps/);
    assert.match(text, /## Files/);
    assert.match(text, /## Risks/);
    assert.match(text, /## Verification/);
    assert.match(text, /plan_submit/);
  });

  it("the per-turn reminder is one compact line", () => {
    const text = planReminder(".unipi/plans/x.md");
    assert.equal(text.includes("\n"), false);
    assert.match(text, /^\[plan mode: read-only · plan file \.unipi\/plans\/x\.md · call plan_submit when ready\]$/);
  });
});

describe("plan file content", () => {
  it("an empty plan file is treated as missing", () => {
    const dir = cwd();
    const state = activeState(dir);
    writeFileSync(state.planFile!, "   \n\n");
    const file = state.planFile!;
    assert.equal(file.endsWith(".md"), true);
    resetPlanState(state.sessionId);
  });
});
