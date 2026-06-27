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

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

/** Default MemPalace palace path. */
export const DEFAULT_PALACE = path.join(os.homedir(), ".mempalace", "palace");

const INSTALL_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-install");
const MIGRATED_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-migrated");

/** Path to the bundled bridge script. */
const BRIDGE_PATH = path.join(dirname(fileURLToPath(import.meta.url)), "bridge", "mempalace_bridge.py");

function dirname(p: string): string {
  return path.dirname(p);
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

/** Drop the cached install record (forces re-detection next session). */
export function invalidateInstallCache(): void {
  try { if (fs.existsSync(INSTALL_FLAG)) fs.unlinkSync(INSTALL_FLAG); } catch { /* ignore */ }
}

/** Has the one-way legacy migration been completed? */
export function isMigrated(): boolean {
  return fs.existsSync(MIGRATED_FLAG);
}

/** Mark the one-way legacy migration complete. */
export function markMigrated(): void {
  try {
    fs.mkdirSync(path.dirname(MIGRATED_FLAG), { recursive: true });
    fs.writeFileSync(MIGRATED_FLAG, new Date().toISOString(), "utf-8");
  } catch { /* ignore */ }
}

/** Force re-migration by clearing the flag. */
export function clearMigratedFlag(): void {
  try { if (fs.existsSync(MIGRATED_FLAG)) fs.unlinkSync(MIGRATED_FLAG); } catch { /* ignore */ }
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
): T | null {
  let argsJson: string;
  try {
    argsJson = JSON.stringify(args);
  } catch {
    return null;
  }
  let res;
  try {
    res = spawnSync(install.python, [BRIDGE_PATH, palace, cmd, argsJson], {
      encoding: "utf-8",
      timeout: 60_000,
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

/** Ping the bridge — returns true if the backend is alive. */
export function ping(install: MempalaceInstall, palace: string): boolean {
  return runBridge<string>(install, palace, "ping") === "pong";
}
