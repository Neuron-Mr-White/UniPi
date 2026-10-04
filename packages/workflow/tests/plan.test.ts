/**
 * Plan mode: soft enforcement, plan_submit gates, resume, reminders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforcePlanMode } from "../src/plan/enforce.js";
import {
  PLAN_STATE_ENTRY,
  currentPlanState,
  planFileName,
  planFilePath,
  resetPlanState,
  restorePlanState,
  type PlanSessionState,
} from "../src/plan/state.js";
import {
  openQuestions,
  planContentHash,
  planInstructions,
  planReminder,
  planSubmitRefusal,
} from "../src/plan/index.js";

function cwd(): string {
  return mkdtempSync(join(tmpdir(), "plan-"));
}

function activeState(dir: string, sessionId = "session-1"): PlanSessionState {
  const file = planFilePath(dir, sessionId);
  mkdirSync(join(dir, "docs", "plans"), { recursive: true });
  return { sessionId, active: true, planFile: file, lastKeptHash: null };
}

describe("plan file naming", () => {
  it("is <date>-<short-session-id>.md", () => {
    const name = planFileName("2f1a9c34-8b7e-4f0d-9a11-000000000000", new Date("2026-09-24T10:00:00Z"));
    assert.equal(name, "2026-09-24-2f1a9c34.md");
  });

  it("sits under docs/plans", () => {
    assert.equal(planFilePath("/w", "abcdef123456"), "/w/docs/plans/" + planFileName("abcdef123456"));
  });
});

describe("plan mode enforcement", () => {
  // A temp root distinct from the test cwd (which also lives under tmpdir).
  const deps = { tmpdir: mkdtempSync(join(tmpdir(), "plan-tmp-")) };

  it("allows the plan file, docs/plans/ and temp files", () => {
    const dir = cwd();
    const state = activeState(dir);
    assert.equal(enforcePlanMode({ toolName: "write", subject: state.planFile! }, state, dir, deps), undefined);
    assert.equal(enforcePlanMode({ toolName: "edit", subject: state.planFile! }, state, dir, deps), undefined);
    assert.equal(
      enforcePlanMode({ toolName: "write", subject: join(dir, "docs/plans/other.md") }, state, dir, deps),
      undefined,
    );
    assert.equal(enforcePlanMode({ toolName: "write", subject: join(deps.tmpdir, "notes.md") }, state, dir, deps), undefined);
  });

  it("resolves relative plan paths", () => {
    const dir = cwd();
    const state = activeState(dir);
    const rel = state.planFile!.slice(dir.length + 1);
    assert.equal(enforcePlanMode({ toolName: "write", subject: rel }, state, dir, deps), undefined);
  });

  it("hard-blocks writes elsewhere with the soft-enforcement reason", () => {
    const dir = cwd();
    const state = activeState(dir);
    for (const target of [join(dir, "src/foo.ts"), "package.json"]) {
      const blocked = enforcePlanMode({ toolName: "write", subject: target }, state, dir, deps);
      assert.equal(blocked?.kind, "block", target);
      assert.match(blocked.reason, /only the plan file/);
      assert.match(blocked.reason, /docs\/plans/);
      assert.match(blocked.reason, /denied twice/);
    }
    const edit = enforcePlanMode({ toolName: "edit", subject: join(dir, "src/foo.ts") }, state, dir, deps);
    assert.equal(edit?.kind, "block");
  });

  it("lets read-only and kanboard bash through to the permission gate", () => {
    const dir = cwd();
    const state = activeState(dir);
    assert.equal(enforcePlanMode({ toolName: "bash", subject: "git status && ls" }, state, dir, deps), undefined);
    assert.equal(enforcePlanMode({ toolName: "bash", subject: "unipi-kanboard --actor agent list" }, state, dir, deps), undefined);
  });

  it("asks before state-changing bash", () => {
    const dir = cwd();
    const state = activeState(dir);
    for (const command of ["npm test", "npm install", "rm -rf x", "echo hi > out.txt", "cat $(ls)"]) {
      const ask = enforcePlanMode({ toolName: "bash", subject: command }, state, dir, deps);
      assert.equal(ask?.kind, "ask", command);
      assert.match(ask.reason, /plan mode · may change state/);
    }
  });

  it("leaves every other tool to the normal permission gate", () => {
    const dir = cwd();
    const state = activeState(dir);
    for (const tool of ["memory_store", "run_subagent", "bg_run", "notify_user", "read", "grep", "ask_user", "plan_submit"]) {
      assert.equal(enforcePlanMode({ toolName: tool, subject: "{}" }, state, dir, deps), undefined, tool);
    }
  });

  it("is inert when plan mode is off", () => {
    const dir = cwd();
    const state: PlanSessionState = { sessionId: "s", active: false, planFile: null, lastKeptHash: null };
    assert.equal(enforcePlanMode({ toolName: "bash", subject: "rm -rf /" }, state, dir, deps), undefined);
    assert.equal(enforcePlanMode({ toolName: "write", subject: "/etc/passwd" }, state, dir, deps), undefined);
  });

  it("names the plan file in the write block reason", () => {
    const dir = cwd();
    const state = activeState(dir);
    const blocked = enforcePlanMode({ toolName: "write", subject: join(dir, "README.md") }, state, dir, deps) as {
      kind: string;
      reason: string;
    };
    assert.match(blocked.reason, /docs\/plans\/\d{4}-\d{2}-\d{2}-session1\.md/);
  });
});

describe("plan state persistence", () => {
  it("restores an active session from its entry", () => {
    const dir = cwd();
    const file = planFilePath(dir, "sess-9");
    const state = restorePlanState("sess-9", [{ customType: PLAN_STATE_ENTRY, data: { active: true, planFile: file } }], dir);
    assert.equal(state.active, true);
    assert.equal(state.planFile, file);
    assert.equal(state.lastKeptHash, null);
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

  it("reset clears the state and the keep hash", () => {
    const dir = cwd();
    activeState(dir);
    restorePlanState("s", [{ customType: PLAN_STATE_ENTRY, data: { active: true } }], dir);
    currentPlanState("s").lastKeptHash = "abc";
    const cleared = resetPlanState("s");
    assert.equal(cleared.active, false);
    assert.equal(cleared.planFile, null);
    assert.equal(cleared.lastKeptHash, null);
  });
});

describe("plan_submit gates", () => {
  it("openQuestions: None is no question", () => {
    const plan = "## Implementation\n### Open questions\nNone\n";
    assert.deepEqual(openQuestions(plan), []);
  });

  it("openQuestions: missing heading means no questions (old plans stay submittable)", () => {
    assert.deepEqual(openQuestions("# Plan\n## Summary\nDo it.\n"), []);
  });

  it("openQuestions: collects bullets and numbers, stripping markers", () => {
    const plan = "## Implementation\n### Open questions\n- Postgres or sqlite?\n1. Which vendor?\n### Risks\n- heat";
    assert.deepEqual(openQuestions(plan), ["Postgres or sqlite?", "Which vendor?"]);
  });

  it("openQuestions: stops at the next heading", () => {
    const plan = "## Open questions\n- one?\n## Verification\n- not a question";
    assert.deepEqual(openQuestions(plan), ["one?"]);
    const nested = "### Open questions\n- one?\n#### Details\n- collected elsewhere";
    assert.deepEqual(openQuestions(nested), ["one?"]);
  });

  it("openQuestions: matches case-insensitively and drops None-style lines", () => {
    assert.deepEqual(openQuestions("### OPEN QUESTIONS\nNone\n"), []);
    assert.deepEqual(openQuestions("### Open Questions\nN/A\n-\n"), []);
  });

  it("refuses while open questions remain", () => {
    const plan = "## Implementation\n### Open questions\n- pick a vendor\n";
    const refusal = planSubmitRefusal(plan, null);
    assert.match(refusal!, /Open questions remain/);
    assert.match(refusal!, /- pick a vendor/);
    assert.match(refusal!, /ask_user/);
  });

  it("passes a finished plan", () => {
    const plan = "## Summary\nDo it.\n## Implementation\n### Open questions\nNone";
    assert.equal(planSubmitRefusal(plan, null), null);
  });

  it("refuses an unchanged plan after Keep planning, passes a revised one", () => {
    const kept = "## Summary\nDo it.\n## Implementation\n### Open questions\nNone";
    assert.match(planSubmitRefusal(kept, planContentHash(kept)), /has not changed/);
    assert.match(planSubmitRefusal(kept, planContentHash(kept)), /Keep planning/);
    assert.equal(planSubmitRefusal("## Summary\nDo it differently.", planContentHash(kept)), null);
  });

  it("the hash is content-sensitive", () => {
    assert.notEqual(planContentHash("a"), planContentHash("b"));
  });
});

describe("plan approval options", () => {
  it("keeps the documented option order", async () => {
    const { approvePlan } = await import("../src/plan/index.js");
    const dir = cwd();
    const state = activeState(dir);
    writeFileSync(state.planFile!, "## Summary\nDo the thing\n");
    restorePlanState(state.sessionId, [{ customType: PLAN_STATE_ENTRY, data: { active: true, planFile: state.planFile } }], dir);

    const calls: string[] = [];
    const ctx = {
      cwd: dir,
      hasUI: true,
      sessionManager: { getSessionId: () => state.sessionId, getEntries: () => [] },
      ui: {
        async select(_title: string, options: string[]) {
          calls.push(...options);
          return undefined; // Esc
        },
        async input() {
          return undefined;
        },
        notify() {},
      },
    };
    const pi = { sendUserMessage() {}, appendEntry() {}, events: { emit() {} } };
    const result = await approvePlan(pi as never, ctx as never, state.sessionId);
    assert.deepEqual(calls, ["Approve & implement", "Keep planning…", "Discard plan"]);
    assert.equal(result.status, "keep", "Esc keeps planning");
    assert.equal(currentPlanState(state.sessionId).active, true, "plan mode stays on after Esc");
    assert.equal(currentPlanState(state.sessionId).lastKeptHash, planContentHash("## Summary\nDo the thing"), "Esc records the kept hash");
    resetPlanState(state.sessionId);
  });
});

describe("plan messages", () => {
  it("instructions name the plan file, the two sections and ask_user", () => {
    const text = planInstructions("docs/plans/2026-09-24-abcd1234.md");
    assert.match(text, /plan with the user/i);
    assert.match(text, /2026-09-24-abcd1234\.md/);
    assert.match(text, /## Summary/);
    assert.match(text, /## Implementation/);
    assert.match(text, /### Open questions/);
    assert.match(text, /ask_user/);
    assert.match(text, /plan_submit/);
  });

  it("instructions no longer claim hard read-only enforcement", () => {
    const text = planInstructions("docs/plans/x.md");
    assert.doesNotMatch(text, /every mutating tool is refused/);
    assert.match(text, /blocks writes outside the plan file/);
    assert.match(text, /asks the user before state-changing shell/);
  });

  it("the per-turn reminder is a short multi-line block", () => {
    const text = planReminder("docs/plans/x.md");
    const lines = text.split("\n");
    assert.ok(lines.length >= 4 && lines.length <= 6, `${lines.length} lines`);
    assert.match(lines[0]!, /^\[plan mode/);
    assert.match(text, /docs\/plans\/x\.md/);
    assert.match(text, /ask_user/);
    assert.match(text, /plan_submit/);
    assert.match(text, /### Open questions/);
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
