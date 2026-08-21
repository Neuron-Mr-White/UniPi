/**
 * @pi-unipi/subagents — Worktree isolation
 *
 * Ported from pi-subagents src/runs/shared/worktree.ts. Managed git worktrees
 * per child (branch unipi-parallel-<runId>-<index> under a base dir; default
 * OS temp, UNIPI_SUBAGENTS_WORKTREE_DIR override), node_modules symlink,
 * optional setup hooks (JSON-in/JSON-out, syntheticPaths validation), diff
 * capture as handoff patches, and cleanup with safety checks: dirty worktrees
 * are preserved unless a captured patch represents the work; discard requires
 * the authorityPolicy to authorize.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeInfo {
  index: number;
  path: string;
  branch: string;
  agentCwd: string;
  syntheticPaths: string[];
}

export interface WorktreeSetup {
  cwd: string;
  worktrees: WorktreeInfo[];
  baseCommit: string;
  capturedDiffs?: WorktreeDiff[];
}

export interface WorktreeDiff {
  index: number;
  agent: string;
  branch: string;
  patchPath: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  diffStat: string;
  error?: string;
}

export interface WorktreeCleanupTask {
  index: number;
  path: string;
  branch: string;
  worktreeRemoved: boolean;
  branchRemoved: boolean;
  preserved?: boolean;
  reason?: string;
  errors?: string[];
}

export type WorktreeCleanupIntent =
  | { kind: "preserve"; capturedDiffs?: WorktreeDiff[]; handoffManifestPath?: string }
  | { kind: "discard"; authorization: { policy: "confirm" | "auto"; kind?: "confirmed" } }
  | { kind: "setup-rollback" };

export interface WorktreeCleanupReport {
  state: "complete" | "partial";
  tasks: WorktreeCleanupTask[];
  pruned: boolean;
  errors?: string[];
}

interface GitResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

interface RepoState {
  toplevel: string;
  cwdRelative: string;
  baseCommit: string;
}

const DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS = 30000;
export const UNIPI_SUBAGENTS_WORKTREE_DIR_ENV = "UNIPI_SUBAGENTS_WORKTREE_DIR";

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function runGitChecked(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    const command = `git -C ${cwd} ${args.join(" ")}`;
    const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

function resolveRepoCwdRelative(cwd: string): string {
  const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
    throw new Error("worktree isolation requires a git repository");
  }
  const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
  const normalizedPrefix = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
  return normalizedPrefix === "." ? "" : normalizedPrefix;
}

function resolveRepoState(cwd: string): RepoState {
  const cwdRelative = resolveRepoCwdRelative(cwd);
  const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const status = runGitChecked(toplevel, ["status", "--porcelain"]);
  if (status.trim().length > 0) {
    throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
  }
  const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
  return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  let existing = resolved;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      missingSegments.push(path.basename(existing));
      existing = parent;
    }
  }
}

export function findWorktreeTaskCwdConflict(
  tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
  sharedCwd: string,
): { index: number; agent: string; cwd: string } | undefined {
  const normalizedSharedCwd = normalizeComparableCwd(sharedCwd);
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!;
    if (!task.cwd) continue;
    const taskCwd = path.isAbsolute(task.cwd) ? task.cwd : path.resolve(sharedCwd, task.cwd);
    if (normalizeComparableCwd(taskCwd) === normalizedSharedCwd) continue;
    return { index, agent: task.agent, cwd: task.cwd };
  }
  return undefined;
}

export function formatWorktreeTaskCwdConflict(
  conflict: { index: number; agent: string; cwd: string },
  sharedCwd: string,
): string {
  return `worktree isolation uses the shared cwd (${sharedCwd}); task ${conflict.index + 1} (${conflict.agent}) sets cwd to ${conflict.cwd}. Remove task-level cwd overrides or disable worktree.`;
}

function safePatchAgentName(agent: string): string {
  return agent.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
  return `unipi-parallel-${runId}-${index}`;
}

function resolveWorktreeBaseDir(configuredBaseDir: string | undefined, repoRoot: string): string {
  const rawBaseDir = configuredBaseDir ?? process.env[UNIPI_SUBAGENTS_WORKTREE_DIR_ENV];
  if (rawBaseDir === undefined) return os.tmpdir();
  const trimmed = rawBaseDir.trim();
  if (!trimmed) throw new Error("worktree base directory cannot be empty");
  const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to create worktree base directory ${resolved}: ${message}`);
  }
  return resolved;
}

function buildWorktreePath(baseDir: string, runId: string, index: number): string {
  return path.join(baseDir, `unipi-worktree-${runId}-${index}`);
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number, baseDir?: string): string {
  const cwdRelative = resolveRepoCwdRelative(cwd);
  const repoRoot = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const worktreePath = buildWorktreePath(resolveWorktreeBaseDir(baseDir, repoRoot), runId, index);
  return cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
  const nodeModulesPath = path.join(toplevel, "node_modules");
  const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
  if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
  try {
    fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
    return true;
  } catch {
    return false;
  }
}

function parseHookTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_WORKTREE_SETUP_HOOK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("worktree setup hook timeout must be an integer greater than 0");
  }
  return timeoutMs;
}

export interface WorktreeSetupHookConfig {
  hookPath: string;
  timeoutMs?: number;
}

interface ResolvedWorktreeSetupHook {
  hookPath: string;
  timeoutMs: number;
}

function resolveWorktreeSetupHook(
  repoRoot: string,
  config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
  if (!config) return undefined;
  const hookPath = config.hookPath.trim();
  if (!hookPath) throw new Error("worktree setup hook path cannot be empty");
  const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
  let resolvedPath: string;
  if (path.isAbsolute(expandedHookPath)) resolvedPath = expandedHookPath;
  else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) resolvedPath = path.resolve(repoRoot, expandedHookPath);
  else throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
  if (!fs.existsSync(resolvedPath)) throw new Error(`worktree setup hook not found: ${resolvedPath}`);
  if (fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
  }
  return { hookPath: resolvedPath, timeoutMs: parseHookTimeout(config.timeoutMs) };
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("synthetic path cannot be empty");
  if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);
  const resolved = path.resolve(worktreePath, trimmed);
  const relative = path.relative(worktreePath, resolved);
  if (!relative || relative === ".") throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
  }
  return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
  const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function runWorktreeSetupHook(hook: ResolvedWorktreeSetupHook, input: Record<string, unknown>): string[] {
  const result = spawnSync(hook.hookPath, [], {
    windowsHide: true,
    cwd: input.worktreePath as string,
    encoding: "utf-8",
    input: JSON.stringify(input),
    timeout: hook.timeoutMs,
    shell: false,
  });

  if (result.error) {
    const code = "code" in result.error ? (result.error as { code?: string }).code : undefined;
    if (code === "ETIMEDOUT") throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
    throw new Error(`worktree setup hook failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim() || "no output";
    throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
  }

  const trimmed = (result.stdout ?? "").trim();
  if (!trimmed) throw new Error("worktree setup hook returned empty stdout; expected JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("worktree setup hook stdout must be a JSON object");
  }
  const output = parsed as { syntheticPaths?: unknown };
  if (output.syntheticPaths === undefined) return [];
  if (!Array.isArray(output.syntheticPaths)) {
    throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
  }
  const uniquePaths = new Set<string>();
  for (const candidate of output.syntheticPaths) {
    if (typeof candidate !== "string") {
      throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
    }
    const normalizedPath = normalizeSyntheticPath(input.worktreePath as string, candidate);
    if (hasTrackedEntries(input.worktreePath as string, normalizedPath)) {
      throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
    }
    uniquePaths.add(normalizedPath);
  }
  return [...uniquePaths];
}

function createSingleWorktree(
  toplevel: string,
  cwdRelative: string,
  runId: string,
  index: number,
  baseCommit: string,
  setupHook: ResolvedWorktreeSetupHook | undefined,
  agent: string | undefined,
  baseDir: string,
): WorktreeInfo {
  const branch = buildWorktreeBranch(runId, index);
  const worktreePath = buildWorktreePath(baseDir, runId, index);
  const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
  if (add.status !== 0) {
    const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
    throw new Error(message);
  }

  const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
  try {
    const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
    const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];

    if (setupHook) {
      const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
        version: 1,
        repoRoot: toplevel,
        worktreePath,
        agentCwd,
        branch,
        index,
        runId,
        baseCommit,
        agent,
      });
      syntheticPaths.push(...hookSyntheticPaths);
    }

    return { index, path: worktreePath, branch, agentCwd, syntheticPaths };
  } catch (error) {
    // Roll back this worktree on setup failure.
    try {
      runGitChecked(toplevel, ["worktree", "remove", "--force", worktreePath]);
      runGitChecked(toplevel, ["branch", "-D", branch]);
    } catch {
      // best effort
    }
    throw error;
  }
}

export interface CreateWorktreesOptions {
  agents?: string[];
  setupHook?: WorktreeSetupHookConfig;
  baseDir?: string;
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
  const repo = resolveRepoState(cwd);
  const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
  const baseDir = resolveWorktreeBaseDir(options?.baseDir, repo.toplevel);
  const worktrees: WorktreeInfo[] = [];

  try {
    for (let index = 0; index < count; index++) {
      worktrees.push(
        createSingleWorktree(repo.toplevel, repo.cwdRelative, runId, index, repo.baseCommit, setupHook, options?.agents?.[index], baseDir),
      );
    }
  } catch (error) {
    cleanupWorktrees({ cwd: repo.toplevel, worktrees, baseCommit: repo.baseCommit }, { kind: "setup-rollback" });
    throw error;
  }

  return { cwd: repo.toplevel, worktrees, baseCommit: repo.baseCommit };
}

function writeEmptyPatch(patchPath: string): void {
  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, "");
}

function captureWorktreeDiff(
  setup: WorktreeSetup,
  worktree: WorktreeInfo,
  agent: string,
  patchPath: string,
): WorktreeDiff {
  // Diff ALL work on the branch: committed (vs the setup base commit) and
  // uncommitted, excluding synthetic paths so helper files don't pollute patches.
  const excludeArgs = worktree.syntheticPaths.flatMap((p) => ["--", `:!${p}`]);
  const diffStat = runGitChecked(worktree.path, ["diff", "--stat", setup.baseCommit, ...excludeArgs]);
  const patch = runGit(worktree.path, ["diff", setup.baseCommit, ...excludeArgs]);

  fs.mkdirSync(path.dirname(patchPath), { recursive: true });
  fs.writeFileSync(patchPath, patch.stdout);

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diffStat.split("\n")) {
    const match = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (match) {
      filesChanged = Number(match[1]);
      insertions = Number(match[2] ?? 0);
      deletions = Number(match[3] ?? 0);
    }
  }
  // Untracked files count as changes.
  const untracked = runGit(worktree.path, ["status", "--porcelain"]);
  const hasUntracked = untracked.stdout
    .split("\n")
    .some((line) => line.startsWith("??") && !worktree.syntheticPaths.some((p) => line.includes(p)));

  return {
    index: worktree.index,
    agent,
    branch: worktree.branch,
    patchPath,
    filesChanged: filesChanged + (hasUntracked ? 1 : 0),
    insertions,
    deletions,
    diffStat,
  };
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
  try {
    fs.mkdirSync(diffsDir, { recursive: true });
  } catch {
    return [];
  }

  const diffs: WorktreeDiff[] = [];
  for (let index = 0; index < setup.worktrees.length; index++) {
    const worktree = setup.worktrees[index]!;
    const agent = agents[index] ?? `task-${index + 1}`;
    const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
    try {
      diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
    } catch (error) {
      writeEmptyPatch(patchPath);
      diffs.push({
        index,
        agent,
        branch: worktree.branch,
        patchPath,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        diffStat: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  setup.capturedDiffs = diffs;
  return diffs;
}

function handoffRecordsPatch(handoffManifestPath: string | undefined, patchPath: string): boolean {
  if (!handoffManifestPath) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(handoffManifestPath, "utf8")) as { patches?: string[] };
    return Array.isArray(manifest.patches) && manifest.patches.includes(patchPath);
  } catch {
    return false;
  }
}

function cleanupSingleWorktree(setup: WorktreeSetup, worktree: WorktreeInfo, intent: WorktreeCleanupIntent): WorktreeCleanupTask {
  const errors: string[] = [];
  let worktreeRemoved = false;
  let branchRemoved = false;

  // Safety: is there unrepresented work?
  const status = runGit(worktree.path, ["status", "--porcelain"]);
  if (status.status !== 0) {
    return {
      index: worktree.index,
      path: worktree.path,
      branch: worktree.branch,
      worktreeRemoved: false,
      branchRemoved: false,
      preserved: true,
      reason: "cleanup safety check failed",
      errors: [...errors, `cleanup refused: git status failed`],
    };
  }

  // Work = uncommitted changes OR committed changes on the branch that the
  // base commit does not contain (diff against the setup base commit).
  const baseDiff = runGit(worktree.path, ["diff", "--stat", setup.baseCommit, "HEAD"]);
  const hasWork =
    status.stdout.trim().length > 0 ||
    baseDiff.status === 0
      ? status.stdout.trim().length > 0 || (baseDiff.status === 0 && baseDiff.stdout.trim().length > 0)
      : true;

  if (hasWork && intent.kind === "preserve") {
    const captured = (intent.capturedDiffs ?? setup.capturedDiffs)?.find((diff) => diff.index === worktree.index);
    const patchCaptured =
      captured !== undefined &&
      captured.error === undefined &&
      fs.existsSync(captured.patchPath) &&
      fs.statSync(captured.patchPath).size > 0 &&
      handoffRecordsPatch(intent.handoffManifestPath, captured.patchPath);
    if (!patchCaptured) {
      const reason = "worktree contains changes that are not represented by a captured handoff patch";
      return {
        index: worktree.index,
        path: worktree.path,
        branch: worktree.branch,
        worktreeRemoved: false,
        branchRemoved: false,
        preserved: true,
        reason,
        errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
      };
    }
  }

  if (hasWork && intent.kind === "discard") {
    const authorized = intent.authorization.policy === "auto" || intent.authorization.kind === "confirmed";
    if (!authorized) {
      const reason = "worktree discard requires explicit user confirmation";
      return {
        index: worktree.index,
        path: worktree.path,
        branch: worktree.branch,
        worktreeRemoved: false,
        branchRemoved: false,
        preserved: true,
        reason,
        errors: [...errors, `cleanup refused: ${reason}; preserved ${worktree.path}`],
      };
    }
  }

  // setup-rollback removes unconditionally (setup failed before any work).

  try {
    runGitChecked(setup.cwd, ["worktree", "remove", "--force", worktree.path]);
    worktreeRemoved = true;
  } catch (error) {
    errors.push(`worktree removal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (worktreeRemoved) {
    try {
      runGitChecked(setup.cwd, ["branch", "-D", worktree.branch]);
      branchRemoved = true;
    } catch (error) {
      errors.push(`branch removal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    index: worktree.index,
    path: worktree.path,
    branch: worktree.branch,
    worktreeRemoved,
    branchRemoved,
    ...(errors.length ? { errors } : {}),
  };
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
  return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function cleanupWorktrees(
  setup: WorktreeSetup,
  intent: WorktreeCleanupIntent = { kind: "preserve", ...(setup.capturedDiffs ? { capturedDiffs: setup.capturedDiffs } : {}) },
): WorktreeCleanupReport {
  const tasks: WorktreeCleanupTask[] = [];
  for (let index = setup.worktrees.length - 1; index >= 0; index--) {
    tasks.push(cleanupSingleWorktree(setup, setup.worktrees[index]!, intent));
  }
  tasks.sort((left, right) => left.index - right.index);
  const errors: string[] = [];
  let pruned = false;
  try {
    runGitChecked(setup.cwd, ["worktree", "prune"]);
    pruned = true;
  } catch (error) {
    errors.push(`worktree prune failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const state = tasks.every((task) => task.worktreeRemoved && task.branchRemoved) && pruned ? "complete" : "partial";
  return { state, tasks, pruned, ...(errors.length ? { errors } : {}) };
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
  const changed = diffs.filter(hasWorktreeChanges);
  if (changed.length === 0) return "";

  const lines: string[] = ["=== Worktree Changes ===", ""];
  for (const diff of changed) {
    lines.push(`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`);
    if (diff.diffStat.trim().length > 0) lines.push(diff.diffStat);
    lines.push("");
  }

  const patchesDir = path.dirname(changed[0]!.patchPath);
  lines.push(`Full patches: ${patchesDir}`);
  return lines.join("\n").trimEnd();
}
