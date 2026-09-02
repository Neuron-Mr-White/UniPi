/**
 * @unipi/memory — MemPalace backend client
 *
 * Detects and auto-installs MemPalace (via uv), then invokes the bundled
 * Python bridge (bridge/mempalace_bridge.py) once per operation using the
 * MemPalace venv python. Each call is a synchronous spawnSync that prints
 * one JSON line.
 *
 * If MemPalace or uv is unavailable, all operations return null so the
 * storage layer can fall back to the legacy SQLite path. Memory must never
 * hard-fail because the backend is missing.
 */

import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { loadEmbeddingConfig } from "./settings.js";

/** Default MemPalace palace path. */
export const DEFAULT_PALACE = path.join(os.homedir(), ".mempalace", "palace");

const INSTALL_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-install");
const MIGRATED_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-migrated");
/** Flag written after a successful ping, so subsequent sessions can skip
 *  the ~0.5s Python cold-start sanity check. Stale after PING_VERIFIED_TTL_MS. */
const PING_VERIFIED_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-ping-verified");
const PING_VERIFIED_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Migration marker schema. Increment when migration semantics change. */
export const MIGRATION_STATE_VERSION = 2;

export interface MigrationResult {
  discovered: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  verified: number;
  errors?: string[];
}

export interface MigrationState {
  version: number;
  completedAt: string;
  sourceFingerprint: string;
  result: MigrationResult;
}

let cachedBridgePath: string | null | undefined;

function isReadableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile() && fs.accessSync(candidate, fs.constants.R_OK) === undefined;
  } catch {
    return false;
  }
}

/**
 * Resolve the Python bridge in both supported layouts:
 *
 * - standalone @pi-unipi/memory: <package>/bridge/mempalace_bridge.py
 * - bundled @pi-unipi/unipi:     <umbrella>/packages/memory/bridge/...
 *
 * The explicit environment override is useful for custom packagers. The
 * package-resolution fallback handles npm layouts where dependencies are not
 * hoisted beside the umbrella package.
 */
export function resolveMempalaceBridgePath(moduleUrl = import.meta.url): string | null {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates: string[] = [];
  if (process.env.UNIPI_MEMPALACE_BRIDGE) {
    candidates.push(path.resolve(process.env.UNIPI_MEMPALACE_BRIDGE));
  }
  candidates.push(
    path.join(moduleDir, "bridge", "mempalace_bridge.py"),
    path.join(moduleDir, "..", "memory", "bridge", "mempalace_bridge.py"),
  );

  try {
    const require = createRequire(moduleUrl);
    const memoryPackage = require.resolve("@pi-unipi/memory/package.json");
    candidates.push(path.join(path.dirname(memoryPackage), "bridge", "mempalace_bridge.py"));
  } catch { /* standalone/source layout may not expose package resolution */ }

  return candidates.find(isReadableFile) ?? null;
}

function getBridgePath(): string | null {
  if (cachedBridgePath === undefined) cachedBridgePath = resolveMempalaceBridgePath();
  return cachedBridgePath;
}

export interface BridgeResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface MempalaceRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  project: string;
  type: "preference" | "decision" | "pattern" | "summary";
  created: string;
  updated: string;
}

export interface MempalaceSearchResult extends MempalaceRecord {
  score: number;
  snippet: string;
}

export interface MempalaceListItem {
  id: string;
  title: string;
  type: string;
}

export interface MempalaceListItemAll extends MempalaceListItem {
  project: string;
}

export interface MempalaceInstall {
  python: string;
  version: string;
}

/** Check whether a binary is on PATH. */
function which(bin: string): string | null {
  try {
    const res = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (res.status === 0 || res.stdout || res.stderr) return bin;
  } catch { /* ignore */ }
  // Fallback: `which`
  try {
    const res = spawnSync("which", [bin], { encoding: "utf-8" });
    if (res.status === 0) return res.stdout.trim() || null;
  } catch { /* ignore */ }
  return null;
}

/**
 * Locate the MemPalace venv python after a `uv tool install mempalace`.
 * Uses `uv tool dir` to find the venv root.
 */
function findVenvPython(): string | null {
  try {
    const res = spawnSync("uv", ["tool", "dir"], { encoding: "utf-8", timeout: 5000 });
    if (res.status !== 0 || !res.stdout.trim()) return null;
    const candidate = path.join(res.stdout.trim(), "mempalace", "bin", "python");
    if (fs.existsSync(candidate)) return candidate;
    // Some platforms use Scripts/ on Windows — not relevant here but be safe.
    const win = path.join(res.stdout.trim(), "mempalace", "Scripts", "python.exe");
    if (fs.existsSync(win)) return win;
  } catch { /* ignore */ }
  return null;
}

/** Read a cached install record. */
function readCachedInstall(): MempalaceInstall | null {
  try {
    if (fs.existsSync(INSTALL_FLAG)) {
      const parsed = JSON.parse(fs.readFileSync(INSTALL_FLAG, "utf-8"));
      if (parsed && parsed.python && fs.existsSync(parsed.python)) {
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Persist an install record so we don't re-detect every session. */
function writeCachedInstall(install: MempalaceInstall): void {
  try {
    fs.mkdirSync(path.dirname(INSTALL_FLAG), { recursive: true });
    fs.writeFileSync(INSTALL_FLAG, JSON.stringify(install, null, 2), "utf-8");
  } catch { /* ignore */ }
}

/** Detect mempalace version via the venv python. */
function detectVersion(python: string): string {
  try {
    const res = spawnSync(python, ["-c", "import mempalace; print(getattr(mempalace,'__version__','unknown'))"], { encoding: "utf-8", timeout: 5000 });
    return (res.stdout || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Ensure MemPalace is installed and return the venv python path.
 * Auto-installs via `uv tool install mempalace` if missing and uv is
 * available. Returns null if MemPalace cannot be made available (caller
 * should fall back to legacy SQLite storage).
 */
export function ensureMempalace(): MempalaceInstall | null {
  const cached = readCachedInstall();
  if (cached) return cached;

  // 1. Already installed via uv tool? Locate venv python.
  let python = findVenvPython();

  // 2. If not, and uv is available, install it.
  if (!python && which("uv")) {
    try {
      const res = spawnSync("uv", ["tool", "install", "mempalace"], {
        encoding: "utf-8",
        timeout: 180_000, // first install downloads deps + embedding model
      });
      if (res.status === 0) {
        python = findVenvPython();
      }
    } catch { /* ignore — fall back */ }
  }

  if (!python) return null;

  const version = detectVersion(python);
  const install = { python, version };
  writeCachedInstall(install);
  return install;
}

/** Was the palace ping-verified recently enough to trust without re-pinging? */
export function isPingVerified(): boolean {
  try {
    if (!fs.existsSync(PING_VERIFIED_FLAG)) return false;
    const ts = Number.parseInt(fs.readFileSync(PING_VERIFIED_FLAG, "utf-8").trim(), 10);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < PING_VERIFIED_TTL_MS;
  } catch { return false; }
}

/** Mark the palace as ping-verified (written after a successful ping). */
export function markPingVerified(): void {
  try {
    fs.mkdirSync(path.dirname(PING_VERIFIED_FLAG), { recursive: true });
    fs.writeFileSync(PING_VERIFIED_FLAG, String(Date.now()), "utf-8");
  } catch { /* ignore */ }
}

/** Drop the ping-verified flag (forces a real ping next session). */
export function invalidatePingVerified(): void {
  try { if (fs.existsSync(PING_VERIFIED_FLAG)) fs.unlinkSync(PING_VERIFIED_FLAG); } catch { /* ignore */ }
}

/**
 * Fingerprint all durable legacy sources. This makes migration catch-up
 * automatic for existing installations instead of treating a years-old
 * timestamp flag as permanently complete.
 */
export function getMemorySourceFingerprint(
  sourceDir = path.join(os.homedir(), ".unipi", "memory"),
): string {
  const hash = createHash("sha256");
  if (!fs.existsSync(sourceDir)) return hash.update("missing").digest("hex");

  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      hash.update(`unreadable:${dir}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile() || (entry.name !== "memory.db" && !entry.name.endsWith(".md"))) continue;
      try {
        const stat = fs.statSync(full);
        hash.update(`${path.relative(sourceDir, full)}\0${stat.size}\0${stat.mtimeMs}\n`);
      } catch {
        hash.update(`unreadable:${path.relative(sourceDir, full)}\n`);
      }
    }
  };
  visit(sourceDir);
  return hash.digest("hex");
}

/** Read a verified v2 migration state. Legacy timestamp markers return null. */
export function readMigrationState(flagPath = MIGRATED_FLAG): MigrationState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf-8")) as MigrationState;
    if (
      parsed?.version !== MIGRATION_STATE_VERSION ||
      typeof parsed.completedAt !== "string" ||
      typeof parsed.sourceFingerprint !== "string" ||
      !parsed.result ||
      parsed.result.failed !== 0 ||
      parsed.result.verified !== parsed.result.discovered
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Is the palace verified against the current durable source set? */
export function isMigrated(
  sourceFingerprint = getMemorySourceFingerprint(),
  flagPath = MIGRATED_FLAG,
): boolean {
  return readMigrationState(flagPath)?.sourceFingerprint === sourceFingerprint;
}

/** Mark migration complete only after the caller has verified every record. */
export function markMigrated(
  sourceFingerprint: string,
  result: MigrationResult,
  flagPath = MIGRATED_FLAG,
): boolean {
  if (result.failed !== 0 || result.verified !== result.discovered) return false;
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const state: MigrationState = {
      version: MIGRATION_STATE_VERSION,
      completedAt: new Date().toISOString(),
      sourceFingerprint,
      result,
    };
    const temp = `${flagPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(temp, flagPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one bridge command synchronously. Returns the parsed result, or null
 * on any failure (timeout, non-zero exit, bad JSON, ok=false).
 */
export function runBridge<T = unknown>(
  install: MempalaceInstall,
  palace: string,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): T | null {
  const bridgePath = getBridgePath();
  if (!bridgePath) return null;
  let argsJson: string;
  try {
    argsJson = JSON.stringify(args);
  } catch {
    return null;
  }
  let res;
  try {
    res = spawnSync(install.python, [bridgePath, palace, cmd, argsJson], {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  if (res.error || res.status !== 0) {
    return null;
  }
  const out = (res.stdout || "").trim();
  if (!out) return null;
  try {
    const parsed = JSON.parse(out) as BridgeResponse<T>;
    if (!parsed.ok) return null;
    return (parsed.result ?? null) as T | null;
  } catch {
    return null;
  }
}

/**
 * Async variant of runBridge that does not block the event loop.
 *
 * spawnSync freezes the process for the whole Python round-trip (~0.5-1.1s).
 * Use this from any path that runs while the UI is live — startup status,
 * background refreshes — so keystrokes stay responsive.
 */
export function runBridgeAsync<T = unknown>(
  install: MempalaceInstall,
  palace: string,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<T | null> {
  return new Promise((resolve) => {
    const bridgePath = getBridgePath();
    if (!bridgePath) {
      resolve(null);
      return;
    }
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args);
    } catch {
      resolve(null);
      return;
    }

    let child;
    try {
      child = spawn(install.python, [bridgePath, palace, cmd, argsJson], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }

    let out = "";
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    // Do not hold the process open purely for a background bridge call.
    timer.unref?.();

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) return finish(null);
      const trimmed = out.trim();
      if (!trimmed) return finish(null);
      try {
        const parsed = JSON.parse(trimmed) as BridgeResponse<T>;
        finish(parsed.ok ? ((parsed.result ?? null) as T | null) : null);
      } catch {
        finish(null);
      }
    });
  });
}

/** Ping the bridge — returns true if the backend is alive. */
export function ping(install: MempalaceInstall, palace: string): boolean {
  return runBridge<string>(install, palace, "ping") === "pong";
}

// ── Auto-update (TTL-gated PyPI check + `uv tool upgrade`) ────────────────

/** Update check state file — records the last check so we hit PyPI ~daily. */
const UPDATE_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-update");
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PYPI_URL = "https://pypi.org/pypi/mempalace/json";

export interface MempalaceUpdateState {
  checkedAt: number;
  latestVersion: string;
}

export interface MempalaceUpdateOutcome {
  checked: boolean;
  updated: boolean;
  currentVersion?: string;
  latestVersion?: string;
  reason?: "disabled" | "not-installed" | "recent" | "lookup-failed" | "up-to-date" | "uv-missing" | "upgrade-failed";
}

/** Read the cached update-check state (null when missing/corrupt). */
export function readUpdateState(flagPath = UPDATE_FLAG): MempalaceUpdateState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf-8")) as MempalaceUpdateState;
    if (typeof parsed?.checkedAt !== "number" || typeof parsed?.latestVersion !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the update-check state atomically. */
export function writeUpdateState(state: MempalaceUpdateState, flagPath = UPDATE_FLAG): void {
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const temp = `${flagPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(temp, flagPath);
  } catch { /* ignore */ }
}

/** Is a PyPI lookup due? (no state yet, or the TTL has elapsed) */
export function isUpdateCheckDue(
  flagPath = UPDATE_FLAG,
  now = Date.now(),
  ttlMs = UPDATE_CHECK_TTL_MS,
): boolean {
  const state = readUpdateState(flagPath);
  if (!state) return true;
  return now - state.checkedAt >= ttlMs;
}

/** Numeric dotted-version compare: >0 if a is newer, <0 if older, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a ?? "").trim().split(".");
  const pb = String(b ?? "").trim().split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0") || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** Latest MemPalace version on PyPI, or null on any failure. */
export async function fetchLatestMempalaceVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(PYPI_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { info?: { version?: string } };
    return typeof body?.info?.version === "string" ? body.info.version : null;
  } catch {
    return null;
  }
}

/** Is the opt-in MemPalace daemon currently running? */
function daemonRunning(): boolean {
  try {
    const res = spawnSync("mempalace", ["daemon", "status"], { encoding: "utf-8", timeout: 10_000 });
    return /is running/i.test(res.stdout || "");
  } catch {
    return false;
  }
}

/** Fire-and-forget process run; resolves null on spawn failure or non-zero exit. */
function runProcess(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Upgrade MemPalace via `uv tool install --upgrade`. The daemon (if running)
 * is stopped first and restarted after, so the long-lived process picks up
 * the new venv instead of straddling versions.
 */
async function upgradeMempalace(): Promise<boolean> {
  if (!which("uv")) return false;
  const wasRunning = daemonRunning();
  if (wasRunning) await runProcess("mempalace", ["daemon", "stop"], 30_000);
  const upgraded = await runProcess("uv", ["tool", "upgrade", "mempalace"], 300_000);
  if (wasRunning) await runProcess("mempalace", ["daemon", "start"], 30_000);
  return upgraded;
}

export interface MempalaceUpdateOptions {
  /** Skip the TTL gate and force a PyPI lookup. */
  force?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override "now" for TTL math (tests). */
  now?: number;
}

/**
 * Keep the user's MemPalace install current.
 *
 * TTL-gated (~daily) PyPI lookup; when a newer release exists and the install
 * came from uv, runs `uv tool upgrade mempalace` in the background. Never
 * throws — callers fire-and-forget this from session_start.
 */
export async function maybeAutoUpdateMempalace(
  options: MempalaceUpdateOptions = {},
): Promise<MempalaceUpdateOutcome> {
  const now = options.now ?? Date.now();
  if (loadEmbeddingConfig().mempalaceAutoUpdate === false) {
    return { checked: false, updated: false, reason: "disabled" };
  }
  const install = readCachedInstall();
  if (!install) return { checked: false, updated: false, reason: "not-installed" };

  if (!options.force && !isUpdateCheckDue(UPDATE_FLAG, now, UPDATE_CHECK_TTL_MS)) {
    return { checked: false, updated: false, reason: "recent" };
  }

  const latest = await fetchLatestMempalaceVersion(options.fetchImpl).catch(() => null);
  const previous = readUpdateState()?.latestVersion ?? "";
  writeUpdateState({ checkedAt: now, latestVersion: latest ?? previous });
  if (!latest) {
    return { checked: true, updated: false, currentVersion: install.version, reason: "lookup-failed" };
  }

  const current = detectVersion(install.python);
  if (compareVersions(latest, current) <= 0) {
    return { checked: true, updated: false, currentVersion: current, latestVersion: latest, reason: "up-to-date" };
  }

  const upgraded = await upgradeMempalace();
  if (!upgraded) {
    return { checked: true, updated: false, currentVersion: current, latestVersion: latest, reason: "upgrade-failed" };
  }

  // Refresh the cached install record so the new version is used next bridge call.
  const python = findVenvPython();
  if (python) writeCachedInstall({ python, version: detectVersion(python) });
  invalidatePingVerified();
  return { checked: true, updated: true, currentVersion: current, latestVersion: latest };
}
