/**
 * Worktree tests — ported from pi-subagents worktree semantics using a real
 * temp git repo: create/link/cleanup lifecycle, dirty-worktree preservation,
 * patch-represented cleanup, authority-gated discard, setup hooks with
 * syntheticPaths validation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktrees,
  diffWorktrees,
  cleanupWorktrees,
  formatWorktreeDiffSummary,
  findWorktreeTaskCwdConflict,
} from "../worktree.js";

let repo: string;
let baseSeq = 0;

/** Unique per-process+test worktree base dir, OUTSIDE the repo (keeps the tree clean). */
function freshBaseDir(): string {
  baseSeq += 1;
  return `${repo}.wt-base-${baseSeq}`;
}

function git(args: string, cwd = repo): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "unipi-worktree-test-"));
  git("init -q");
  git('config user.email "t@t"');
  git('config user.name "t"');
  writeFileSync(join(repo, "base.txt"), "base\n");
  git("add .");
  git("commit -qm base");
});

afterEach(() => {
  // Force-remove worktrees registered under this repo.
  try {
    git("worktree prune");
  } catch { /* ignore */ }
  rmSync(repo, { recursive: true, force: true });
});

describe("worktree lifecycle", () => {
  it("creates isolated worktrees with branches; clean setup cleans up fully", () => {
    const setup = createWorktrees(repo, "run-1", 2, { baseDir: freshBaseDir() });
    assert.equal(setup.worktrees.length, 2);
    assert.ok(setup.worktrees[0]!.path.includes("unipi-worktree-run-1-0"));
    assert.equal(setup.worktrees[0]!.branch, "unipi-parallel-run-1-0");
    assert.ok(existsSync(setup.worktrees[0]!.path));

    const report = cleanupWorktrees(setup, { kind: "setup-rollback" });
    assert.equal(report.state, "complete");
    assert.equal(existsSync(setup.worktrees[0]!.path), false);
  });

  it("requires a clean working tree", () => {
    writeFileSync(join(repo, "dirty.txt"), "dirt\n");
    assert.throws(
      () => createWorktrees(repo, "run-2", 1, { baseDir: freshBaseDir() }),
      /requires a clean git working tree/,
    );
  });

  it("requires a git repository", () => {
    const notGit = mkdtempSync(join(tmpdir(), "unipi-notgit-"));
    try {
      assert.throws(
        () => createWorktrees(notGit, "r", 1, { baseDir: freshBaseDir() }),
        /requires a git repository/,
      );
    } finally {
      rmSync(notGit, { recursive: true, force: true });
    }
  });
});

describe("diff + cleanup safety", () => {
  it("dirty worktree is preserved without a handoff patch; removed with one", () => {
    const baseDir = freshBaseDir();
    const setup = createWorktrees(repo, "run-3", 1, { baseDir });
    const wt = setup.worktrees[0]!;

    // Make changes in the worktree.
    writeFileSync(join(wt.path, "new.txt"), "change\n");
    git("add new.txt", wt.path);
    git('commit -qm "work"', wt.path);

    const diffsDir = join(baseDir, "diffs");
    const diffs = diffWorktrees(setup, ["worker"], diffsDir);
    assert.equal(diffs.length, 1);

    // Preserve intent without a handoff manifest → refused.
    const preserved = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs });
    assert.equal(preserved.tasks[0]!.preserved, true);
    assert.match(preserved.tasks[0]!.reason!, /not represented by a captured handoff patch/);
    assert.ok(existsSync(wt.path));

    // With a handoff manifest recording the patch → removed.
    const manifest = join(diffsDir, "handoff.json");
    writeFileSync(manifest, JSON.stringify({ patches: [diffs[0]!.patchPath] }));
    const cleaned = cleanupWorktrees(setup, { kind: "preserve", capturedDiffs: diffs, handoffManifestPath: manifest });
    assert.equal(cleaned.tasks[0]!.worktreeRemoved, true);
    assert.equal(existsSync(wt.path), false);
  });

  it("discard of dirty worktree requires confirmation; auto policy proceeds", () => {
    const baseDir = freshBaseDir();
    const setup = createWorktrees(repo, "run-4", 1, { baseDir });
    const wt = setup.worktrees[0]!;
    writeFileSync(join(wt.path, "uncommitted.txt"), "wip\n");

    // confirm policy without confirmation → refused
    const refused = cleanupWorktrees(setup, { kind: "discard", authorization: { policy: "confirm" } });
    assert.equal(refused.tasks[0]!.preserved, true);
    assert.match(refused.tasks[0]!.reason!, /requires explicit user confirmation/);

    // confirmed kind → proceeds
    const setup2 = createWorktrees(repo, "run-5", 1, { baseDir });
    const wt2 = setup2.worktrees[0]!;
    writeFileSync(join(wt2.path, "uncommitted.txt"), "wip\n");
    const discarded = cleanupWorktrees(setup2, { kind: "discard", authorization: { policy: "confirm", kind: "confirmed" } });
    assert.equal(discarded.tasks[0]!.worktreeRemoved, true);
    assert.equal(existsSync(wt2.path), false);
  });

  it("clean worktree removes without any patch requirement", () => {
    const baseDir = freshBaseDir();
    const setup = createWorktrees(repo, "run-6", 1, { baseDir });
    const report = cleanupWorktrees(setup, { kind: "preserve" });
    assert.equal(report.tasks[0]!.worktreeRemoved, true);
    assert.equal(report.state, "complete");
  });
});

describe("setup hooks", () => {
  it("runs the hook with JSON input and honors syntheticPaths", () => {
    const hookPath = `${repo}.setup-hook.mjs`;
    writeFileSync(
      hookPath,
      [
        "#!/usr/bin/env node",
        "const chunks = [];",
        "process.stdin.on('data', (c) => chunks.push(c));",
        "process.stdin.on('end', () => {",
        "  const input = JSON.parse(Buffer.concat(chunks).toString());",
        `  process.stdout.write(JSON.stringify({ syntheticPaths: [".venv", "scratch"] }));`,
        "});",
      ].join("\n"),
    );
    chmodSync(hookPath, 0o755);

    const baseDir = freshBaseDir();
    const setup = createWorktrees(repo, "run-7", 1, { baseDir, setupHook: { hookPath } });
    assert.deepEqual(setup.worktrees[0]!.syntheticPaths, [".venv", "scratch"]);
    cleanupWorktrees(setup, { kind: "setup-rollback" });
  });

  it("rejects hooks marking tracked paths as synthetic", () => {
    const hookPath = `${repo}.bad-hook.mjs`;
    writeFileSync(
      hookPath,
      [
        "#!/usr/bin/env node",
        "const chunks = [];",
        "process.stdin.on('data', (c) => chunks.push(c));",
        "process.stdin.on('end', () => {",
        `  process.stdout.write(JSON.stringify({ syntheticPaths: ["base.txt"] }));`,
        "});",
      ].join("\n"),
    );
    chmodSync(hookPath, 0o755);

    assert.throws(
      () => createWorktrees(repo, "run-8", 1, { baseDir: freshBaseDir(), setupHook: { hookPath } }),
      /cannot mark tracked paths as synthetic/,
    );
  });
});

describe("misc", () => {
  it("formatWorktreeDiffSummary renders changed tasks and patch dir", () => {
    const summary = formatWorktreeDiffSummary([
      { index: 0, agent: "worker", branch: "b", patchPath: "/tmp/d/task-0-worker.patch", filesChanged: 2, insertions: 10, deletions: 3, diffStat: " a | 5 +++++" },
    ]);
    assert.match(summary, /=== Worktree Changes ===/);
    assert.match(summary, /Task 1 \(worker\): 2 files changed/);
    assert.match(summary, /Full patches: \/tmp\/d/);
    assert.equal(formatWorktreeDiffSummary([]), "");
  });

  it("findWorktreeTaskCwdConflict detects non-shared cwds", () => {
    assert.equal(findWorktreeTaskCwdConflict([{ agent: "a", cwd: repo }], repo), undefined);
    assert.equal(findWorktreeTaskCwdConflict([{ agent: "a", cwd: "/elsewhere" }], repo)?.index, 0);
    assert.equal(findWorktreeTaskCwdConflict([{ agent: "a" }], repo), undefined);
  });
});
