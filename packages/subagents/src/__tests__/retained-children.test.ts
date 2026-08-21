/**
 * Retained children + resume tests — ported from pi-subagents
 * retained-children semantics: resumability rules (session file checks),
 * newest-first listing with the resumable-retained guarantee, prefix
 * resolution, and handler wiring for children.list/resume.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRetainedChildren,
  formatRetainedChildren,
  resolveResumeTarget,
} from "../retained-children.js";
import { handleSpawnHelper, type HandlerDeps } from "../tool-handler.js";
import { AgentManager } from "../agent-manager.js";
import type { SubagentsConfig } from "../types.js";

let asyncDir: string;
let sessionFile: string;

function writeRun(
  runId: string,
  status: Record<string, unknown>,
  opts: { withSession?: boolean } = {},
): void {
  const runDir = join(asyncDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "status.json"),
    JSON.stringify({ updatedAt: Date.now(), ...status }),
  );
  if (opts.withSession) {
    writeFileSync(sessionFile, '{"type":"session"}\n');
  }
}

beforeEach(() => {
  asyncDir = mkdtempSync(join(tmpdir(), "unipi-retained-"));
  sessionFile = join(asyncDir, "child-session.jsonl");
});

afterEach(() => {
  rmSync(asyncDir, { recursive: true, force: true });
});

describe("listRetainedChildren", () => {
  it("lists terminal runs only, newest first", () => {
    writeRun("old-complete", { status: "completed", agent: "worker", sessionFile }, { withSession: true });
    writeRun("running-run", { status: "running", agent: "scout" });
    writeRun("failed-run", { status: "failed", agent: "reviewer" });

    const children = listRetainedChildren(asyncDir);
    assert.equal(children.length, 2);
    assert.equal(children[0]!.state === "completed" || children[0]!.state === "failed", true);
    assert.ok(children.every((c) => c.runId !== "running-run"));
  });

  it("resumability: valid .jsonl session file is resumable; missing/invalid is not", () => {
    writeRun("resumable-run", { status: "completed", agent: "worker", sessionFile }, { withSession: true });
    writeRun("no-session", { status: "completed", agent: "worker" });
    writeRun("stopped-run", { status: "stopped", agent: "worker", sessionFile }, { withSession: true });

    const children = listRetainedChildren(asyncDir);
    const byId = new Map(children.map((c) => [c.runId, c]));
    assert.equal(byId.get("resumable-run")!.resumability.state, "resumable");
    assert.equal(byId.get("no-session")!.resumability.state, "not-resumable");
    assert.match((byId.get("no-session")!.resumability as { reason: string }).reason, /no persisted session file/);
    // stopped runs are listed but not resumable
    assert.equal(byId.get("stopped-run")!.resumability.state, "not-resumable");
    assert.match((byId.get("stopped-run")!.resumability as { reason: string }).reason, /stopped run/);
  });

  it("formatRetainedChildren keeps a resumable child visible and shows resume syntax", () => {
    for (let i = 0; i < 12; i++) {
      writeRun(`filler-${i}`, { status: "failed", agent: "worker" });
    }
    writeRun("the-resumable", { status: "completed", agent: "worker", sessionFile }, { withSession: true });

    const text = formatRetainedChildren(listRetainedChildren(asyncDir));
    assert.match(text, /the-resumable/);
    assert.match(text, /resumability: resumable/);
    assert.match(text, /spawn_helper\(\{ action: "resume"/);
  });
});

describe("resolveResumeTarget", () => {
  it("resolves unique prefixes to resumable runs; rejects ambiguous/non-resumable", () => {
    writeRun("abc12345-completed", { status: "completed", agent: "worker", sessionFile }, { withSession: true });
    writeRun("abc99999-failed", { status: "failed", agent: "worker" });

    const ok = resolveResumeTarget(asyncDir, "abc12345");
    assert.ok(ok.ok && ok.agent === "worker" && ok.sessionFile.endsWith(".jsonl"));

    const ambiguous = resolveResumeTarget(asyncDir, "abc");
    assert.equal(ambiguous.ok, false);
    assert.match((ambiguous as { error: string }).error, /matches 2 retained children/);

    const notResumable = resolveResumeTarget(asyncDir, "abc99999");
    assert.equal(notResumable.ok, false);
    assert.match((notResumable as { error: string }).error, /not resumable/);

    const missing = resolveResumeTarget(asyncDir, "zzz");
    assert.equal(missing.ok, false);
    assert.match((missing as { error: string }).error, /No retained child matches/);
  });
});

describe("handler wiring", () => {
  function makeDeps(configOverrides: Partial<SubagentsConfig> = {}): HandlerDeps & { __calls: unknown[] } {
    const calls: unknown[] = [];
    const config: SubagentsConfig = { maxConcurrent: 4, enabled: true, types: {}, ...configOverrides };
    const deps = {
      pi: {} as never,
      retainedDir: asyncDir,
      manager: new AgentManager(undefined, 4, undefined, {}, "/tmp", { user: {}, project: {} }),
      config,
      spawnForeground: async (_c: never, agent: string) => ({ ok: true, output: `ran ${agent}`, toolUses: 1, durationMs: 5 }),
      spawnBackground: () => "id",
      env: {},
    } as HandlerDeps & { __calls: unknown[] };
    deps.__calls = calls;
    return deps;
  }
  const ctx = {} as never;

  it("children.list shows retained children when present", async () => {
    writeRun("listed-run", { status: "completed", agent: "worker", sessionFile }, { withSession: true });
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { action: "children.list" });
    assert.match(result.content[0]!.text, /listed-run/);
    assert.match(result.content[0]!.text, /resumability: resumable/);
    deps.manager.dispose();
  });

  it("resume requires id + message; routes through runAsync with the stored contract", async () => {
    writeRun("resume-me-1", { status: "completed", agent: "oracle", sessionFile }, { withSession: true });
    const deps = makeDeps();
    const launches: Array<Record<string, unknown>> = [];
    deps.runAsync = async (launch) => {
      launches.push(launch as unknown);
      return { runId: "new-run-9", status: "running" };
    };

    const noMessage = await handleSpawnHelper(deps, ctx, { action: "resume", id: "resume-me-1" });
    assert.match(noMessage.content[0]!.text, /requires a non-empty follow-up message/);

    const ok = await handleSpawnHelper(deps, ctx, { action: "resume", id: "resume-me-1", message: "Reconsider." });
    assert.match(ok.content[0]!.text, /Resumed resume-me-1 as new-run-9/);
    assert.match(ok.content[0]!.text, /agent: oracle/);
    assert.equal(launches.length, 1);
    assert.equal((launches[0] as { agentName: string }).agentName, "oracle");
    assert.equal((launches[0] as { resumeSessionFile?: string }).resumeSessionFile, sessionFile);
    deps.manager.dispose();
  });

  it("resume without the process runner errors clearly", async () => {
    writeRun("resume-me-2", { status: "completed", agent: "worker", sessionFile }, { withSession: true });
    const deps = makeDeps();
    const result = await handleSpawnHelper(deps, ctx, { action: "resume", id: "resume-me-2", message: "go" });
    assert.match(result.content[0]!.text, /background process runner, which is unavailable/);
    deps.manager.dispose();
  });
});
