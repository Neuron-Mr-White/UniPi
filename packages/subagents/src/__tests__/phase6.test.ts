/**
 * Phase 6 tests — supervisor channel (file-based request/reply lifecycle,
 * expiry cleanup, overlap of multiple children), acceptance gates
 * (validation, report parsing, criteria checks, verify commands), and
 * authority policy.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSupervisorChannelDir,
  ensureSupervisorChannelDir,
  childContactSupervisor,
  listPendingSupervisorRequests,
  replyToSupervisorRequest,
  readChildSupervisorMetadata,
  SUPERVISOR_CHANNEL_DIR_ENV,
  SUPERVISOR_RUN_ID_ENV,
  SUPERVISOR_AGENT_ENV,
  SUPERVISOR_PARENT_SESSION_ENV,
} from "../supervisor-channel.js";
import {
  validateAcceptanceInput,
  normalizeAcceptanceInput,
  normalizeGateAcceptance,
  parseAcceptanceReport,
  stripAcceptanceReport,
  evaluateAcceptance,
} from "../acceptance.js";
import { resolveAuthorityDecision, authorityPolicyFromConfig } from "../authority-policy.js";

describe("supervisor channel", () => {
  let root: string;
  let channelDir: string;
  const REAL_ENV = { ...process.env };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "unipi-supervisor-"));
    channelDir = resolveSupervisorChannelDir(root, "run-1", "worker");
    ensureSupervisorChannelDir(channelDir);
    process.env[SUPERVISOR_CHANNEL_DIR_ENV] = channelDir;
    process.env[SUPERVISOR_RUN_ID_ENV] = "run-1";
    process.env[SUPERVISOR_AGENT_ENV] = "worker";
    process.env[SUPERVISOR_PARENT_SESSION_ENV] = "parent-1";
  });

  afterEach(() => {
    for (const key of [SUPERVISOR_CHANNEL_DIR_ENV, SUPERVISOR_RUN_ID_ENV, SUPERVISOR_AGENT_ENV, SUPERVISOR_PARENT_SESSION_ENV]) {
      delete process.env[key];
    }
    Object.assign(process.env, REAL_ENV);
    rmSync(root, { recursive: true, force: true });
  });

  it("child metadata requires all four env vars", () => {
    assert.ok(readChildSupervisorMetadata());
    delete process.env[SUPERVISOR_PARENT_SESSION_ENV];
    assert.equal(readChildSupervisorMetadata(), undefined);
  });

  it("progress_update posts without blocking", () => {
    const result = childContactSupervisor({ reason: "progress_update", message: "halfway done" });
    assert.equal(result.replied, false);
    const pending = listPendingSupervisorRequests(root);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.reason, "progress_update");
    assert.equal(pending[0]!.expectsReply, false);
  });

  it("need_decision blocks until the parent replies (child subprocess)", async () => {
    // The child's blocking wait parks its own event loop; run it as a real
    // subprocess so this test can poll + reply concurrently.
    const { execFile } = await import("node:child_process");
    const { writeFile: writeTempFile } = await import("node:fs/promises");
    const childScript = join(process.cwd(), `.supervisor-child-${Date.now()}.mts`);
    await writeTempFile(
      childScript,
      [
        'import { childContactSupervisor } from "./src/supervisor-channel.js";',
        `const result = childContactSupervisor({ reason: "need_decision", message: "which approach?", timeoutMs: 20000 }, {`,
        `  channelDir: ${JSON.stringify(channelDir)},`,
        `  runId: "run-1",`,
        `  agent: "worker",`,
        `  parentSessionId: "parent-1",`,
        `});`,
        "console.log(JSON.stringify(result));",
      ].join("\n"),
    );

    const childDone = new Promise<{ replied: boolean; reply?: string }>((resolve, reject) => {
      execFile(process.execPath, [process.argv0.includes("tsx") ? "" : "", "--import", "tsx", childScript].filter(Boolean), {
        cwd: process.cwd(),
        encoding: "utf8" as const,
        timeout: 30_000,
      }, (error: unknown, stdout: unknown) => {
        if (error && (error as { code?: number }).code !== 0) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve(JSON.parse((stdout as string).trim().split("\n").pop()!));
      });
    });

    // Parent: poll and reply when the request appears.
    const deadline = Date.now() + 15_000;
    let replied = false;
    while (Date.now() < deadline) {
      const pending = listPendingSupervisorRequests(root);
      if (pending.length > 0) {
        replyToSupervisorRequest(root, pending[0]!.id, "use approach B");
        replied = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(replied, "request never appeared");

    const result = await childDone;
    try {
      rmSync(childScript, { force: true });
    } catch { /* best effort */ }
    assert.equal(result.replied, true);
    assert.equal(result.reply, "use approach B");
    assert.equal(listPendingSupervisorRequests(root).length, 0);
  });

  it("expired requests are cleaned up on listing", () => {
    // Manually write an expired request.
    const requestsDir = join(channelDir, "requests");
    writeFileSync(
      join(requestsDir, "expired.json"),
      JSON.stringify({
        type: "subagent.supervisor.request",
        id: "expired",
        createdAt: Date.now() - 60_000,
        expiresAt: Date.now() - 30_000,
        reason: "need_decision",
        message: "old",
        expectsReply: true,
        runId: "run-1",
        agent: "worker",
      }),
    );
    assert.equal(listPendingSupervisorRequests(root).length, 0);
    assert.equal(listPendingSupervisorRequests(root).length, 0); // cleaned
  });

  it("replyToSupervisorRequest returns false for unknown ids", () => {
    assert.equal(replyToSupervisorRequest(root, "nope", "hi"), false);
  });
});

describe("acceptance gates", () => {
  it("validates input shapes (reference error strings)", () => {
    assert.deepEqual(validateAcceptanceInput(undefined), []);
    assert.match(validateAcceptanceInput("bogus")[0]!, /invalid level 'bogus'/);
    assert.match(validateAcceptanceInput("none")[0]!, /requires a reason/);
    assert.match(validateAcceptanceInput("verified")[0]!, /requires object form/);
    assert.match(validateAcceptanceInput({ level: "none" })[0]!, /reason is required/);
    assert.match(validateAcceptanceInput({ level: "verified", verify: [] })[0]!, /at least one runtime command/);
    assert.match(validateAcceptanceInput({ bogus: 1 })[0]!, /bogus is not supported/);
    assert.match(validateAcceptanceInput({ level: "checked", criteria: [{ id: "x" }] })[0]!, /must is required/);
    assert.deepEqual(validateAcceptanceInput({ level: "checked" }), []);
  });

  it("gate shorthand normalizes to verified with a gate command", () => {
    const config = normalizeGateAcceptance("npm test");
    assert.equal(config!.level, "verified");
    assert.equal(config!.verify![0]!.command, "npm test");
  });

  it("parses and strips structured reports", () => {
    const output = 'work done\n<acceptance-report>\n{"criteria":[{"id":"a","satisfied":true}]}\n</acceptance-report>';
    const parsed = parseAcceptanceReport(output);
    assert.equal(parsed.report!.criteria![0]!.id, "a");
    const stripped = stripAcceptanceReport(output);
    assert.equal(stripped, "work done");
    assert.match(parseAcceptanceReport("no report").error!, /not found/);
  });

  it("evaluate: none → not-required; attested without report → rejected", async () => {
    const none = await evaluateAcceptance({ acceptance: { level: "none" }, output: "x", cwd: "/tmp" });
    assert.equal(none.status, "not-required");

    const attested = await evaluateAcceptance({ acceptance: { level: "attested" }, output: "no report", cwd: "/tmp" });
    assert.equal(attested.status, "rejected");

    const withReport = await evaluateAcceptance({
      acceptance: { level: "attested" },
      output: '<acceptance-report>{"criteria":[]}</acceptance-report>',
      cwd: "/tmp",
    });
    assert.equal(withReport.status, "attested");
  });

  it("evaluate: criteria failures reject; satisfied criteria reach checked", async () => {
    const criteria = [{ id: "tests", must: "tests pass", severity: "required" as const }];
    const failing = await evaluateAcceptance({
      acceptance: { level: "checked", criteria },
      output: '<acceptance-report>{"criteria":[{"id":"tests","satisfied":false}]}</acceptance-report>',
      cwd: "/tmp",
    });
    assert.equal(failing.status, "rejected");

    const passing = await evaluateAcceptance({
      acceptance: { level: "checked", criteria },
      output: '<acceptance-report>{"criteria":[{"id":"tests","satisfied":true}]}</acceptance-report>',
      cwd: "/tmp",
    });
    assert.equal(passing.status, "checked");
  });

  it("evaluate: verified runs host commands; failures reject with the verify id", async () => {
    const passing = await evaluateAcceptance({
      acceptance: { level: "verified", verify: [{ id: "echo-ok", command: "echo ok" }] },
      output: '<acceptance-report>{"criteria":[]}</acceptance-report>',
      cwd: tmpdir(),
    });
    assert.equal(passing.status, "verified");
    assert.equal(passing.verifyRuns[0]!.status, "passed");

    const failing = await evaluateAcceptance({
      acceptance: { level: "verified", verify: [{ id: "must-fail", command: "exit 3" }] },
      output: '<acceptance-report>{"criteria":[]}</acceptance-report>',
      cwd: tmpdir(),
    });
    assert.equal(failing.status, "rejected");
    assert.match(failing.failureMessage!, /verification 'must-fail' failed/);
  });

  it("recommended criteria missing from the report do not reject", async () => {
    const ledger = await evaluateAcceptance({
      acceptance: {
        level: "checked",
        criteria: [
          { id: "hard", must: "required", severity: "required" },
          { id: "nice", must: "optional", severity: "recommended" },
        ],
      },
      output: '<acceptance-report>{"criteria":[{"id":"hard","satisfied":true}]}</acceptance-report>',
      cwd: "/tmp",
    });
    assert.equal(ledger.status, "checked");
  });

  it("normalizeAcceptanceInput handles shorthand", () => {
    assert.equal(normalizeAcceptanceInput("checked")!.level, "checked");
    assert.equal(normalizeAcceptanceInput(false), undefined);
  });
});

describe("authority policy", () => {
  it("defaults to confirm for destructive actions; auto for scheduleCreate", () => {
    assert.equal(resolveAuthorityDecision({ action: "discardWorktree" }), "confirm");
    assert.equal(resolveAuthorityDecision({ action: "scheduleCreate" }), "auto");
  });

  it("confirmed kind satisfies confirm policy; auto policy passes through", () => {
    assert.equal(resolveAuthorityDecision({ action: "discardWorktree", confirmed: true }), "auto");
    assert.equal(resolveAuthorityDecision({ action: "discardWorktree", policy: { discardWorktree: "auto" } }), "auto");
  });

  it("parses only valid policy keys/values from config", () => {
    const policy = authorityPolicyFromConfig({ discardWorktree: "auto", bogus: "auto", destructiveCleanup: "nope" });
    assert.equal(policy.discardWorktree, "auto");
    assert.equal(policy.bogus, undefined);
    assert.equal(policy.destructiveCleanup, undefined);
  });
});
