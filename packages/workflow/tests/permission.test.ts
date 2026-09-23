/**
 * The mode × tool decision matrix, jev stubs, the approval prompt, and no-UI
 * behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideToolCall, jevRiskState, type DecideDeps, type JevRisk } from "../src/permission/decide.js";
import { requestApproval } from "../src/permission/prompt.js";
import { suggestPattern, type PermissionRule } from "../src/permission/rules.js";
import { readPermissionSettings, registerPermissionSettings, type PermissionMode } from "../src/permission/settings.js";

const CWD = "/workspace/project";

function deps(overrides: Partial<DecideDeps> = {}): DecideDeps {
  return {
    mode: "auto",
    jevJudge: true,
    jevConfidence: 0.7,
    rules: [],
    cwd: CWD,
    tmpdir: "/tmp",
    hasUI: true,
    ...overrides,
  };
}

const safeJev = async (): Promise<JevRisk> => ({ choice: "safe", confidence: 0.95 });
const riskyJev = async (): Promise<JevRisk> => ({ choice: "needs_approval", confidence: 0.82 });
const nullJev = async (): Promise<JevRisk | null> => null;

describe("read-only tools", () => {
  for (const tool of ["read", "grep", "find", "ls", "memory_search", "web_search", "ffgrep", "fffind", "session_recall", "bg_status", "ask_user"]) {
    it(`${tool} is always allowed`, async () => {
      for (const mode of ["ask", "auto", "full"] as PermissionMode[]) {
        const decision = await decideToolCall({ toolName: tool, subject: "" }, deps({ mode }));
        assert.equal(decision.action, "allow", `${tool} in ${mode}`);
      }
    });
  }
});

describe("write / edit", () => {
  for (const tool of ["write", "edit"]) {
    it(`${tool} inside the workspace is allowed in auto and full`, async () => {
      for (const mode of ["auto", "full"] as PermissionMode[]) {
        const decision = await decideToolCall({ toolName: tool, subject: "src/a.ts" }, deps({ mode }));
        assert.equal(decision.action, "allow");
      }
    });

    it(`${tool} inside the workspace asks in ask mode`, async () => {
      const decision = await decideToolCall({ toolName: tool, subject: "src/a.ts" }, deps({ mode: "ask" }));
      assert.equal(decision.action, "ask");
    });

    it(`${tool} outside the workspace always asks`, async () => {
      for (const mode of ["auto", "full"] as PermissionMode[]) {
        const decision = await decideToolCall({ toolName: tool, subject: "/etc/hosts" }, deps({ mode }));
        assert.equal(decision.action, "ask");
        assert.match(decision.action === "ask" ? decision.reason : "", /outside the workspace/);
      }
    });

    it(`${tool} into the temp dir is allowed in auto`, async () => {
      const decision = await decideToolCall({ toolName: tool, subject: join(tmpdir(), "scratch.ts") }, deps());
      assert.equal(decision.action, "allow");
    });
  }
});

describe("bash matrix", () => {
  it("read-only bash is silent in auto and full", async () => {
    for (const mode of ["auto", "full"] as PermissionMode[]) {
      const decision = await decideToolCall({ toolName: "bash", subject: "git status && ls" }, deps({ mode }));
      assert.equal(decision.action, "allow");
    }
  });

  it("read-only bash asks in ask mode", async () => {
    const decision = await decideToolCall({ toolName: "bash", subject: "ls" }, deps({ mode: "ask" }));
    assert.equal(decision.action, "ask");
  });

  it("dangerous bash asks in auto and ask, and is allowed in full", async () => {
    const auto = await decideToolCall({ toolName: "bash", subject: "rm -rf /tmp/wd-test" }, deps());
    assert.equal(auto.action, "ask");
    assert.match(auto.action === "ask" ? auto.reason : "", /^dangerous: rm -rf$/);

    const ask = await decideToolCall({ toolName: "bash", subject: "rm -rf /tmp/wd-test" }, deps({ mode: "ask" }));
    assert.equal(ask.action, "ask");

    const full = await decideToolCall({ toolName: "bash", subject: "rm -rf /tmp/wd-test" }, deps({ mode: "full" }));
    assert.equal(full.action, "allow");
  });

  it("unknown bash is allowed when jev says safe above the threshold", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm install left-pad" },
      deps({ askJevRisk: safeJev }),
    );
    assert.equal(decision.action, "allow");
    assert.match(decision.action === "allow" ? decision.reason : "", /jev: safe 0\.95/);
  });

  it("unknown bash asks when jev says needs_approval", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm publish" },
      deps({ askJevRisk: riskyJev }),
    );
    assert.equal(decision.action, "ask");
    assert.match(decision.action === "ask" ? decision.reason : "", /jev: needs_approval 0\.82/);
  });

  it("a safe verdict below the confidence threshold still asks", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm install left-pad" },
      deps({ jevConfidence: 0.99, askJevRisk: safeJev }),
    );
    assert.equal(decision.action, "ask");
  });

  it("jev null (error/timeout/no key) asks", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm install left-pad" },
      deps({ askJevRisk: nullJev }),
    );
    assert.equal(decision.action, "ask");
    assert.match(decision.action === "ask" ? decision.reason : "", /jev: unavailable/);
  });

  it("jevJudge off asks in auto", async () => {
    let called = false;
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm install left-pad" },
      deps({ jevJudge: false, askJevRisk: async () => { called = true; return safeJev(); } }),
    );
    assert.equal(decision.action, "ask");
    assert.equal(called, false, "jev must not be consulted when disabled");
  });

  it("the agent's kanboard CLI is allowed in auto and full, asks in ask mode", async () => {
    const command = "unipi-kanboard --actor agent --project p-1 move UNI-3 blocked --comment 'need format'";
    for (const mode of ["auto", "full"] as PermissionMode[]) {
      const decision = await decideToolCall({ toolName: "bash", subject: command }, deps({ mode }));
      assert.equal(decision.action, "allow", `${mode}: ${JSON.stringify(decision)}`);
      assert.match(decision.action === "allow" ? decision.reason : "", /kanboard CLI/);
    }
    const asked = await decideToolCall({ toolName: "bash", subject: command }, deps({ mode: "ask" }));
    assert.equal(asked.action, "ask");
  });

  it("a kanboard CLI call with --actor user is not covered by the allowance", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "unipi-kanboard --actor user move UNI-3 done" },
      deps({ askJevRisk: riskyJev }),
    );
    assert.equal(decision.action, "ask", "normal rules apply");
  });

  it("full mode never asks", async () => {
    const decision = await decideToolCall({ toolName: "bash", subject: "npm publish" }, deps({ mode: "full" }));
    assert.equal(decision.action, "allow");
  });
});

describe("other tools", () => {
  it("are allowed in auto and full", async () => {
    for (const mode of ["auto", "full"] as PermissionMode[]) {
      const decision = await decideToolCall({ toolName: "spawn_helper", subject: "{}" }, deps({ mode }));
      assert.equal(decision.action, "allow");
    }
  });

  it("ask in ask mode", async () => {
    const decision = await decideToolCall({ toolName: "spawn_helper", subject: "{}" }, deps({ mode: "ask" }));
    assert.equal(decision.action, "ask");
  });
});

describe("saved rules", () => {
  const allow: PermissionRule = { tool: "bash", pattern: "npm install *", decision: "allow", scope: "project" };
  const deny: PermissionRule = { tool: "*", pattern: "*publish*", decision: "deny", scope: "project" };

  it("an allow rule short-circuits in ask mode", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm install left-pad" },
      deps({ mode: "ask", rules: [allow] }),
    );
    assert.equal(decision.action, "allow");
  });

  it("a deny rule blocks even in full mode", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm publish --access public" },
      deps({ mode: "full", rules: [deny] }),
    );
    assert.equal(decision.action, "block");
    assert.match(decision.action === "block" ? decision.reason : "", /saved deny rule/);
  });

  it("a deny rule blocks read-only tools too", async () => {
    const decision = await decideToolCall(
      { toolName: "read", subject: "secret.txt" },
      deps({ rules: [{ tool: "read", pattern: "secret*", decision: "deny", scope: "project" }] }),
    );
    assert.equal(decision.action, "block");
  });

  it("rules match the resolved write path", async () => {
    const decision = await decideToolCall(
      { toolName: "write", subject: "docs/plans/p.md" },
      deps({ rules: [{ tool: "write", pattern: `${CWD}/docs/plans/*`, decision: "allow", scope: "project" }] }),
    );
    assert.equal(decision.action, "allow");
  });
});

describe("no UI", () => {
  it("runs normal commands instead of prompting", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm install left-pad" },
      deps({ hasUI: false, askJevRisk: riskyJev }),
    );
    assert.equal(decision.action, "allow");
  });

  it("blocks dangerous patterns with a reason", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "rm -rf /" },
      deps({ hasUI: false }),
    );
    assert.equal(decision.action, "block");
    assert.match(decision.action === "block" ? decision.reason : "", /no UI to confirm/);
  });

  it("blocks deny rules", async () => {
    const decision = await decideToolCall(
      { toolName: "bash", subject: "npm publish" },
      deps({ hasUI: false, rules: [{ tool: "bash", pattern: "npm publish*", decision: "deny", scope: "project" }] }),
    );
    assert.equal(decision.action, "block");
  });

  it("allows writes outside the workspace", async () => {
    const decision = await decideToolCall({ toolName: "write", subject: "/etc/hosts" }, deps({ hasUI: false }));
    assert.equal(decision.action, "allow");
  });
});

describe("jevRiskState", () => {
  it("carries the cwd basename and the command", () => {
    const state = jevRiskState("/home/me/project", "npm install left-pad");
    assert.equal(state, "cwd: project\ncommand: npm install left-pad");
  });

  it("truncates long commands to 1500 chars", () => {
    const state = jevRiskState("/x/y", "a".repeat(2000));
    assert.equal(state.length, "cwd: y\ncommand: ".length + 1500);
  });
});

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, initial: string): Promise<string | undefined>;
    notify(message: string, level?: string): void;
  };
  prompt?: { title: string; options: string[] };
  notifications: string[];
}

function fakeCtx(choice: string | undefined, note?: string): FakeCtx {
  const ctx: FakeCtx = {
    cwd: mkdtempSync(join(tmpdir(), "perm-")),
    hasUI: true,
    notifications: [],
    ui: {
      async select(title, options) {
        ctx.prompt = { title, options };
        return choice;
      },
      async input() {
        return note;
      },
      notify(message) {
        ctx.notifications.push(message);
      },
    },
  };
  return ctx;
}

const settings = { mode: "auto" as PermissionMode, jevJudge: true, jevConfidence: 0.7, rules: [] };
const request = {
  toolName: "bash",
  summary: "rm -rf /tmp/wd-test",
  reason: "dangerous: rm -rf",
  subject: "rm -rf /tmp/wd-test",
};

describe("approval prompt", () => {
  registerPermissionSettings();

  it("offers the options in the documented order with Allow once first", async () => {
    const ctx = fakeCtx("Deny");
    await requestApproval(ctx as never, request, settings);
    assert.deepEqual(ctx.prompt!.options, [
      "Allow once",
      "Always allow `rm -rf /tmp/wd-test`",
      "Deny",
      "Deny with note…",
    ]);
    assert.match(ctx.prompt!.title, /^Allow bash: rm -rf \/tmp\/wd-test\?\n/);
    assert.match(ctx.prompt!.title, /dangerous: rm -rf/);
  });

  it("Enter (first option) allows once without saving a rule", async () => {
    const ctx = fakeCtx("Allow once");
    const outcome = await requestApproval(ctx as never, request, settings);
    assert.equal(outcome.decision, "allow");
    assert.equal(outcome.savedRule, undefined);
  });

  it("Always allow saves a project-scoped rule", async () => {
    const ctx = fakeCtx("Always allow `rm -rf /tmp/wd-test`");
    const outcome = await requestApproval(ctx as never, request, settings);
    assert.equal(outcome.decision, "allow");
    assert.equal(outcome.savedRule?.decision, "allow");
    assert.equal(outcome.savedRule?.scope, "project");
    assert.equal(outcome.savedRule?.pattern, "rm -rf /tmp/wd-test");
    assert.equal(ctx.notifications.length, 1);
  });

  it("saves the rule into the project settings file", async () => {
    const ctx = fakeCtx("Always allow `rm -rf /tmp/wd-test`");
    await requestApproval(ctx as never, request, settings);
    const stored = readPermissionSettings(ctx.cwd);
    assert.equal(stored.rules.length, 1);
    assert.equal(stored.rules[0]?.pattern, "rm -rf /tmp/wd-test");
    assert.equal(stored.rules[0]?.decision, "allow");
    assert.equal(stored.rules[0]?.scope, "project");
  });

  it("matches the always-allow label to the suggestion", async () => {
    const ctx = fakeCtx(undefined);
    const outcome = await requestApproval(ctx as never, request, settings);
    assert.equal(outcome.decision, "deny", "Esc denies");
    const suggestion = suggestPattern(request.toolName, request.subject);
    assert.equal(ctx.prompt!.options[1], `Always allow \`${suggestion}\``);
  });

  it("Deny with note… carries the note into the outcome", async () => {
    const ctx = fakeCtx("Deny with note…", "that path is a client repo");
    const outcome = await requestApproval(ctx as never, request, settings);
    assert.equal(outcome.decision, "deny");
    assert.equal(outcome.note, "that path is a client repo");
  });
});
