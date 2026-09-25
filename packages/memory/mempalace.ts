/**
 * @unipi/memory — MemPalace install + daemon plumbing
 *
 * Detects/auto-installs MemPalace via uv (venv python is the canonical
 * runtime anchor — the mempalace/mempalace-mcp binaries sit beside it), and
 * probes the opt-in MemPalace daemon via its endpoint.json + token so writes
 * can be routed through it. Reads go through the stdio MCP reader (reader.ts).
 * Everything here is fire-and-forget safe: no function throws into the session.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readMemoryConfig } from "./settings.js";
import { palacePath as palaceFromPaths } from "./paths.js";

/** Default MemPalace palace path (same as paths.palacePath()). */
export const DEFAULT_PALACE = palaceFromPaths();

const INSTALL_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-install");

export interface MempalaceInstall {
  python: string;
  version: string;
}

/** The mempalace/mempalace-mcp binaries live beside the venv python. */
export function venvBin(install: MempalaceInstall, name: string): string {
  return path.join(path.dirname(install.python), name);
}

/** Check whether a binary is on PATH. */
function which(bin: string): string | null {
  try {
    const res = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 5000 });
    if (res.status === 0 || res.stdout || res.stderr) return bin;
  } catch { /* ignore */ }
  try {
    const res = spawnSync("which", [bin], { encoding: "utf-8" });
    if (res.status === 0) return res.stdout.trim() || null;
  } catch { /* ignore */ }
  return null;
}

/** Locate the MemPalace venv python after a `uv tool install mempalace`. */
export function findVenvPython(): string | null {
  try {
    const res = spawnSync("uv", ["tool", "dir"], { encoding: "utf-8", timeout: 5000 });
    if (res.status !== 0 || !res.stdout.trim()) return null;
    const candidate = path.join(res.stdout.trim(), "mempalace", "bin", "python");
    if (fs.existsSync(candidate)) return candidate;
    const win = path.join(res.stdout.trim(), "mempalace", "Scripts", "python.exe");
    if (fs.existsSync(win)) return win;
  } catch { /* ignore */ }
  return null;
}

/** Read a cached install record. */
function readCachedInstall(): MempalaceInstall | null {
  try {
    if (fs.existsSync(INSTALL_FLAG)) {
      const parsed = JSON.parse(fs.readFileSync(INSTALL_FLAG, "utf-8")) as MempalaceInstall;
      if (parsed && parsed.python && fs.existsSync(parsed.python)) {
        return parsed;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** Persist an install record so we don't re-detect every session. */
export function writeCachedInstall(install: MempalaceInstall): void {
  try {
    fs.mkdirSync(path.dirname(INSTALL_FLAG), { recursive: true });
    fs.writeFileSync(INSTALL_FLAG, JSON.stringify(install, null, 2), "utf-8");
  } catch { /* ignore */ }
}

/** Detect mempalace version via the venv python. */
export function detectVersion(python: string): string {
  try {
    const res = spawnSync(python, ["-c", "import mempalace; print(getattr(mempalace,'__version__','unknown'))"], { encoding: "utf-8", timeout: 5000 });
    return (res.stdout || "").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Ensure MemPalace is installed and return the venv python path.
 * Auto-installs via `uv tool install mempalace` when missing and uv is
 * available. Returns null when the backend cannot be made available —
 * memory degrades to markdown-only rather than failing.
 */
export function ensureMempalace(): MempalaceInstall | null {
  const cached = readCachedInstall();
  if (cached) return cached;

  let python = findVenvPython();
  if (!python && which("uv")) {
    try {
      const res = spawnSync("uv", ["tool", "install", "mempalace"], {
        encoding: "utf-8",
        timeout: 180_000,
      });
      if (res.status === 0) {
        python = findVenvPython();
      }
    } catch { /* ignore */ }
  }
  if (!python) return null;

  const install = { python, version: detectVersion(python) };
  writeCachedInstall(install);
  return install;
}

// ── Daemon awareness ─────────────────────────────────────────────────────────
//
// The opt-in MemPalace daemon holds a lifetime write lease on its palace —
// direct collection writes fail with MineAlreadyRunning while it runs, so all
// pi writes go through its /jobs queue. `probeDaemon` reads the endpoint +
// token the daemon drops in its state dir (`~/.mempalace/daemon/<palace_key>`,
// overridable via MEMPALACE_DAEMON_STATE_ROOT).

export interface DaemonStatus {
  /** A daemon endpoint for this palace is reachable and healthy. */
  reachable: boolean;
  /** The daemon is currently running a job (holds the mine lock). */
  busy: boolean;
}

/** Replicate the daemon's palace_key: sha256(realpath(palace))[:24]. */
function palaceKey(palacePath: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(palacePath);
  } catch {
    canonical = path.resolve(palacePath);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function daemonStateDir(palacePath: string): string {
  const root = process.env.MEMPALACE_DAEMON_STATE_ROOT
    ? path.resolve(os.homedir(), process.env.MEMPALACE_DAEMON_STATE_ROOT.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), ".mempalace", "daemon");
  return path.join(root, palaceKey(palacePath));
}

interface DaemonEndpoint {
  host: string;
  port: number;
  token: string;
}

/** Read endpoint.json + token; null when the daemon never wrote them. */
export function daemonEndpoint(palacePath: string): DaemonEndpoint | null {
  try {
    const dir = daemonStateDir(palacePath);
    const endpoint = JSON.parse(
      fs.readFileSync(path.join(dir, "endpoint.json"), "utf-8"),
    ) as { host?: string; port?: number };
    const token = fs.readFileSync(path.join(dir, "token"), "utf-8").trim();
    if (!endpoint.host || !endpoint.port || !token) return null;
    return { host: endpoint.host, port: endpoint.port, token };
  } catch {
    return null;
  }
}

/**
 * Probe the daemon's /health. Never throws — `{reachable:false}` when the
 * endpoint is absent, stale, or the probe times out. `busy` reflects an
 * in-flight job.
 */
export async function probeDaemon(palacePath: string, timeoutMs = 300): Promise<DaemonStatus> {
  const down: DaemonStatus = { reachable: false, busy: false };
  const ep = daemonEndpoint(palacePath);
  if (!ep) return down;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const resp = await fetch(`http://${ep.host}:${ep.port}/health`, {
        headers: { Authorization: `Bearer ${ep.token}` },
        signal: controller.signal,
      });
      if (!resp.ok) return down;
      const health = (await resp.json()) as { ok?: boolean; active_job_id?: unknown };
      if (!health.ok) return down;
      return { reachable: true, busy: health.active_job_id != null };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return down;
  }
}

// ── Process helpers ────────────────────────────────────────────────────────────

/** Fire-and-forget process run; resolves false on spawn failure or non-zero exit. */
export function runProcess(bin: string, args: string[], timeoutMs: number): Promise<boolean> {
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

/** Spawn a process, capturing stdout up to a bounded size, with a timeout. */
export function runProcessOutput(bin: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok ? out : null);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (out.length < 64 * 1024) out += chunk.toString("utf-8");
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/** Spawn a process, capturing stdout AND stderr (bounded), with a timeout. */
export function runProcessCombined(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, stdout: "", stderr: "" });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (c: Buffer) => { if (out.length < 64 * 1024) out += c.toString("utf-8"); });
    child.stderr?.on("data", (c: Buffer) => { if (err.length < 64 * 1024) err += c.toString("utf-8"); });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

// ── Auto-update (TTL-gated PyPI check + `uv tool upgrade`) ────────────────

const UPDATE_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-update");
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
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

export function readUpdateState(flagPath = UPDATE_FLAG): MempalaceUpdateState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf-8")) as MempalaceUpdateState;
    if (typeof parsed?.checkedAt !== "number" || typeof parsed?.latestVersion !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeUpdateState(state: MempalaceUpdateState, flagPath = UPDATE_FLAG): void {
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const temp = `${flagPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(temp, flagPath);
  } catch { /* ignore */ }
}

export function isUpdateCheckDue(
  flagPath = UPDATE_FLAG,
  now = Date.now(),
  ttlMs = UPDATE_CHECK_TTL_MS,
): boolean {
  const state = readUpdateState(flagPath);
  if (!state) return true;
  return now - state.checkedAt >= ttlMs;
}

export function compareVersions(a: string, b: string): number {
  const pa = String(a ?? "").trim().split(".");
  const pb = String(b ?? "").trim().split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

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

async function upgradeMempalace(install: MempalaceInstall): Promise<boolean> {
  if (!which("uv")) return false;
  const cli = venvBin(install, "mempalace");
  const wasRunning = (await probeDaemon(DEFAULT_PALACE)).reachable;
  if (wasRunning) await runProcess(cli, ["--palace", DEFAULT_PALACE, "daemon", "stop"], 30_000);
  const upgraded = await runProcess("uv", ["tool", "upgrade", "mempalace"], 300_000);
  if (wasRunning) await runProcess(cli, ["--palace", DEFAULT_PALACE, "daemon", "start"], 30_000);
  return upgraded;
}

export interface MempalaceUpdateOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
}

/**
 * Keep the user's MemPalace install current. TTL-gated PyPI lookup; upgrades
 * via uv when a newer release exists. Never throws.
 */
export async function maybeAutoUpdateMempalace(
  options: MempalaceUpdateOptions = {},
): Promise<MempalaceUpdateOutcome> {
  const now = options.now ?? Date.now();
  if (readMemoryConfig().mempalaceAutoUpdate === false) {
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

  const upgraded = await upgradeMempalace(install);
  if (!upgraded) {
    return { checked: true, updated: false, currentVersion: current, latestVersion: latest, reason: "upgrade-failed" };
  }

  const python = findVenvPython();
  if (python) writeCachedInstall({ python, version: detectVersion(python) });
  return { checked: true, updated: true, currentVersion: current, latestVersion: latest };
}
