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
/** Record-level sync ledger (L2): supersedes the size+mtime fingerprint gate. */
const LEDGER_FLAG = path.join(os.homedir(), ".unipi", "memory", ".mempalace-ledger.json");
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
  /** Records left untouched by transient palace-lock contention (retryable). */
  deferred?: number;
  verified: number;
  errors?: string[];
  /** "project/id" keys deferred by lock contention, for a targeted retry. */
  deferredKeys?: string[];
  /** "project/id" keys confirmed durable in the palace after the run. */
  verifiedKeys?: string[];
}

export interface MigrationState {
  version: number;
  completedAt: string;
  sourceFingerprint: string;
  result: MigrationResult;
  /** Keys still awaiting a retry after transient lock contention. */
  deferredKeys?: string[];
  /** Consecutive deferred-retry rounds, for exponential backoff. */
  attempts?: number;
  /** Epoch ms; do not retry deferred keys before this. */
  retryAfter?: number;
}

/** Deferred-retry backoff schedule: 15m → 1h → 6h → 24h (capped). */
const DEFERRAL_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];

function deferralBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(attempts, 1), DEFERRAL_BACKOFF_MS.length) - 1;
  return DEFERRAL_BACKOFF_MS[idx] ?? DEFERRAL_BACKOFF_MS[DEFERRAL_BACKOFF_MS.length - 1]!;
}

/** A migrate outcome is complete when nothing genuinely failed and every
 *  discovered record is either verified or transiently deferred. */
export function isMigrationComplete(result: MigrationResult): boolean {
  return result.failed === 0 && result.verified + (result.deferred ?? 0) === result.discovered;
}

/**
 * Normalize the raw bridge migrate payload (snake_case `deferred_keys`) into a
 * `MigrationResult`. Returns null for a missing/malformed payload so callers
 * never advance the marker on garbage.
 */
export function normalizeMigrationResult(raw: unknown): MigrationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (typeof r.discovered !== "number") return null;
  const keys = Array.isArray(r.deferredKeys)
    ? r.deferredKeys
    : Array.isArray(r.deferred_keys)
      ? r.deferred_keys
      : [];
  const vkeysRaw = Array.isArray(r.verifiedKeys)
    ? r.verifiedKeys
    : Array.isArray(r.verified_keys)
      ? r.verified_keys
      : [];
  return {
    discovered: num(r.discovered),
    imported: num(r.imported),
    updated: num(r.updated),
    skipped: num(r.skipped),
    failed: num(r.failed),
    deferred: num(r.deferred),
    verified: num(r.verified),
    errors: Array.isArray(r.errors) ? (r.errors as string[]) : undefined,
    deferredKeys: keys.filter((k): k is string => typeof k === "string"),
    verifiedKeys: vkeysRaw.filter((k): k is string => typeof k === "string"),
  };
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

/**
 * Full outcome of a bridge call. `result` is the parsed value (which may be a
 * legitimate `null`, e.g. a "not found" lookup). `ok` distinguishes a
 * successful call from a failure; `transient` marks failures that are just
 * MemPalace palace-lock contention (retryable), not real backend errors.
 */
export interface BridgeOutcome<T> {
  ok: boolean;
  result: T | null;
  error?: string;
  transient: boolean;
}

/** MemPalace's non-blocking mine lock surfaces as MineAlreadyRunning / "is held by". */
const TRANSIENT_BRIDGE_ERROR = /MineAlreadyRunning|is held by/i;

/** True when a bridge error is transient palace-lock contention, not a real fault. */
export function isTransientBridgeError(error: string | undefined | null): boolean {
  return typeof error === "string" && TRANSIENT_BRIDGE_ERROR.test(error);
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

// ── Daemon awareness (L3) ───────────────────────────────────────────────────
//
// MemPalace can run as a long-lived daemon that holds the per-palace mine lock
// while it mines. That lock is exactly what makes our direct-bridge upserts
// defer (L1). The daemon exposes an HTTP control API, but it has NO idempotent
// record-upsert job — its only generic write (`mcp_tool` -> tool_add_drawer)
// uses a CONTENT-addressed drawer id, whereas our bridge uses a deterministic
// SOURCE-URI-addressed id. Routing our writes through the daemon would fork the
// id scheme and duplicate drawers, so we must NOT do that. Instead we detect a
// reachable daemon and, when it is actively mining, skip the direct catch-up
// this session and let the L1/L2 backoff ride it out — avoiding the lock fight
// rather than joining it. The direct bridge stays the sole write path because
// it alone produces the correct idempotent ids. When no daemon is running
// (per-call / MCP-less mode) nothing changes.

export interface DaemonStatus {
  /** A daemon endpoint for this palace is reachable and healthy. */
  reachable: boolean;
  /** The daemon is currently running a job (holds the mine lock). */
  busy: boolean;
}

/** Replicate the daemon's palace_key: sha256(realpath(palace))[:24] (normcase
 *  is a no-op on POSIX). */
function palaceKey(palacePath: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(palacePath);
  } catch {
    canonical = path.resolve(palacePath);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

function daemonStateDir(palacePath: string): string {
  const root = process.env.MEMPALACE_DAEMON_STATE_ROOT
    ? path.resolve(os.homedir(), process.env.MEMPALACE_DAEMON_STATE_ROOT.replace(/^~(?=$|\/)/, os.homedir()))
    : path.join(os.homedir(), ".mempalace", "daemon");
  return path.join(root, palaceKey(palacePath));
}

/**
 * Probe for a reachable MemPalace daemon for `palacePath` via its endpoint.json
 * + token + /health. Never throws; returns `{reachable:false}` when there is no
 * daemon, the endpoint is stale, or the probe errors/times out. `busy` reflects
 * an in-flight job (active_job_id) — i.e. the mine lock is likely held.
 */
export async function probeDaemon(palacePath: string, timeoutMs = 300): Promise<DaemonStatus> {
  const down: DaemonStatus = { reachable: false, busy: false };
  try {
    const dir = daemonStateDir(palacePath);
    const endpointRaw = fs.readFileSync(path.join(dir, "endpoint.json"), "utf-8");
    const token = fs.readFileSync(path.join(dir, "token"), "utf-8").trim();
    const endpoint = JSON.parse(endpointRaw) as { host?: string; port?: number };
    if (!endpoint.host || !endpoint.port || !token) return down;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const resp = await fetch(`http://${endpoint.host}:${String(endpoint.port)}/health`, {
        headers: { Authorization: `Bearer ${token}` },
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

// ── Record-level sync ledger (L2) ────────────────────────────────────────────
//
// The old size+mtime fingerprint invalidated the whole migration marker on any
// memory write (store() rewrites the .md every time), forcing a full re-sweep.
// The ledger instead tracks, per record, the content hash last confirmed durable
// in the palace. Catch-up then touches only records whose file differs from the
// ledger (out-of-band edits or writes whose palace upsert was deferred), never
// the whole corpus.

export const LEDGER_VERSION = 1;

export interface LedgerEntry {
  /** sha256 of the exact .md bytes last confirmed in the palace. */
  hash: string;
}

export interface Ledger {
  version: number;
  /** "project/id" -> entry. */
  entries: Record<string, LedgerEntry>;
  /** Keys deferred by transient lock contention, awaiting a targeted retry. */
  deferredKeys: string[];
  /** Keys that hit a genuine (non-transient) failure; retried with backoff too. */
  failedKeys: string[];
  /** Consecutive contended/failed rounds, for exponential backoff. */
  attempts: number;
  /** Epoch ms; do not retry deferred/failed keys before this. */
  retryAfter?: number;
  updatedAt: string;
}

/** A record discovered on disk: its key and the hash of its current bytes. */
export interface ScannedRecord {
  key: string;
  project: string;
  id: string;
  hash: string;
}

function emptyLedger(): Ledger {
  return { version: LEDGER_VERSION, entries: {}, deferredKeys: [], failedKeys: [], attempts: 0, updatedAt: new Date(0).toISOString() };
}

/** sha256 of raw file bytes — the scanner and store() hash the same bytes so
 *  the ledger never drifts through a parse/serialize round-trip. */
export function hashBytes(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export function readLedger(flagPath = LEDGER_FLAG): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf-8")) as Partial<Ledger>;
    if (parsed?.version !== LEDGER_VERSION || !parsed.entries || typeof parsed.entries !== "object") {
      return emptyLedger();
    }
    return {
      version: LEDGER_VERSION,
      entries: parsed.entries as Record<string, LedgerEntry>,
      deferredKeys: Array.isArray(parsed.deferredKeys) ? parsed.deferredKeys : [],
      failedKeys: Array.isArray(parsed.failedKeys) ? parsed.failedKeys : [],
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      retryAfter: typeof parsed.retryAfter === "number" ? parsed.retryAfter : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return emptyLedger();
  }
}

export function writeLedger(ledger: Ledger, flagPath = LEDGER_FLAG): boolean {
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const temp = `${flagPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...ledger, version: LEDGER_VERSION }, null, 2), "utf-8");
    fs.renameSync(temp, flagPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan the durable markdown tier and return one record per `.md` file with the
 * hash of its exact bytes. Only markdown is a migration source now (the SQLite
 * fallback was removed), so `memory.db` is deliberately ignored — its churn was
 * a major cause of needless re-sweeps.
 */
export function scanMemorySources(sourceDir = path.join(os.homedir(), ".unipi", "memory")): ScannedRecord[] {
  const out: ScannedRecord[] = [];
  if (!fs.existsSync(sourceDir)) return out;
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const projEntry of projects) {
    if (!projEntry.isDirectory() || projEntry.name.startsWith(".")) continue;
    const project = projEntry.name;
    const projDir = path.join(sourceDir, project);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || f.name.startsWith(".") || !f.name.endsWith(".md")) continue;
      const full = path.join(projDir, f.name);
      let text: string;
      try {
        text = fs.readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      // Key must match the bridge exactly (parse_markdown_memory):
      //  - id: explicit frontmatter `id`, else the filename stem normalized
      //    ([^A-Za-z0-9]+ -> _, trimmed, lowercased).
      //  - project: frontmatter `project` if present, else the directory name.
      // A mismatch would make targeted `--only` retries silently no-op.
      const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text);
      const fm = fmMatch ? fmMatch[1]! : "";
      const readField = (name: string): string => {
        const m = new RegExp(`(^|\\n)${name}:\\s*(.+)`).exec(fm);
        return m ? m[2]!.trim().replace(/^["']|["']$/g, "") : "";
      };
      const explicitId = readField("id");
      const id = explicitId
        || (f.name.replace(/\.md$/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "unknown");
      const recProject = readField("project") || project;
      out.push({ key: `${recProject}/${id}`, project: recProject, id, hash: hashBytes(text) });
    }
  }
  return out;
}

/**
 * Compute which record keys still need a migrate pass: those whose current file
 * hash differs from the ledger, plus any deferred/failed keys whose backoff has
 * elapsed. Returns the keys and whether the ledger has never been populated
 * (→ a first full pass is warranted).
 */
export function ledgerDelta(
  scanned: ScannedRecord[],
  ledger: Ledger,
  now = Date.now(),
): { keys: string[]; firstRun: boolean } {
  const firstRun = Object.keys(ledger.entries).length === 0;
  const due = new Set<string>();
  for (const rec of scanned) {
    if (ledger.entries[rec.key]?.hash !== rec.hash) due.add(rec.key);
  }
  const backoffElapsed = typeof ledger.retryAfter !== "number" || now >= ledger.retryAfter;
  if (backoffElapsed) {
    for (const k of ledger.deferredKeys) due.add(k);
    for (const k of ledger.failedKeys) due.add(k);
  }
  return { keys: [...due], firstRun };
}

/**
 * Fold a migrate result into the ledger: advance the content hash for every
 * verified key, and re-track deferred/failed keys (with backoff) so they retry
 * later. `scannedByKey` gives the on-disk hash to record for a verified key.
 */
export function applyMigrationToLedger(
  ledger: Ledger,
  result: MigrationResult,
  scannedByKey: Map<string, string>,
  now = Date.now(),
): Ledger {
  const entries = { ...ledger.entries };
  for (const key of result.verifiedKeys ?? []) {
    const hash = scannedByKey.get(key);
    if (hash) entries[key] = { hash };
  }
  const deferredKeys = [...new Set(result.deferredKeys ?? [])];
  // Genuine failures are surfaced via error strings; derive their keys from the
  // error prefix "project/id: ..." so they, too, are retried (not silently
  // dropped) but never recorded as synced.
  const failedKeys = [...new Set((result.errors ?? [])
    .map((e) => e.split(":")[0]?.trim())
    .filter((k): k is string => !!k && k.includes("/")))];
  const hadBacklog = deferredKeys.length > 0 || failedKeys.length > 0;
  const attempts = hadBacklog ? ledger.attempts + 1 : 0;
  return {
    version: LEDGER_VERSION,
    entries,
    deferredKeys,
    failedKeys,
    attempts,
    ...(hadBacklog ? { retryAfter: now + deferralBackoffMs(attempts) } : {}),
    updatedAt: new Date(now).toISOString(),
  };
}

/** Record a single successful store() upsert in the ledger. */
export function ledgerRecordStore(key: string, fileText: string, flagPath = LEDGER_FLAG): void {
  const ledger = readLedger(flagPath);
  ledger.entries[key] = { hash: hashBytes(fileText) };
  // A fresh successful write clears any pending retry state for this key.
  ledger.deferredKeys = ledger.deferredKeys.filter((k) => k !== key);
  ledger.failedKeys = ledger.failedKeys.filter((k) => k !== key);
  ledger.updatedAt = new Date().toISOString();
  writeLedger(ledger, flagPath);
}

/**
 * One-time bootstrap: if there is no ledger yet but a completed legacy
 * `.mempalace-migrated` marker exists for the current corpus, seed the ledger
 * from the current on-disk hashes so we do not re-migrate everything once.
 * Deferred keys from the old marker are carried over for targeted retry.
 */
export function bootstrapLedgerFromLegacyMarker(
  sourceDir = path.join(os.homedir(), ".unipi", "memory"),
  ledgerPath = LEDGER_FLAG,
  markerPath = MIGRATED_FLAG,
): Ledger | null {
  if (fs.existsSync(ledgerPath)) return null;
  const marker = readMigrationState(markerPath);
  if (!marker) return null;
  const scanned = scanMemorySources(sourceDir);
  const deferred = new Set(marker.deferredKeys ?? []);
  const entries: Record<string, LedgerEntry> = {};
  for (const rec of scanned) {
    // A record known-deferred under the old marker is NOT yet durable — leave
    // it out of entries so the delta re-attempts it.
    if (deferred.has(rec.key)) continue;
    entries[rec.key] = { hash: rec.hash };
  }
  const ledger: Ledger = {
    version: LEDGER_VERSION,
    entries,
    deferredKeys: [...deferred],
    failedKeys: [],
    attempts: marker.attempts ?? 0,
    ...(marker.retryAfter ? { retryAfter: marker.retryAfter } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeLedger(ledger, ledgerPath);
  return ledger;
}

/** Read a verified migration state. Legacy timestamp markers, wrong-version,
 *  malformed, or non-complete states all return null (→ treated as not
 *  migrated). A state with transiently-deferred records is still complete. */
export function readMigrationState(flagPath = MIGRATED_FLAG): MigrationState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagPath, "utf-8")) as MigrationState;
    if (
      parsed?.version !== MIGRATION_STATE_VERSION ||
      typeof parsed.completedAt !== "string" ||
      typeof parsed.sourceFingerprint !== "string" ||
      !parsed.result ||
      !isMigrationComplete(parsed.result)
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The deferred "project/id" keys due for a targeted retry now, or null when
 * there is nothing to retry (no complete marker for this fingerprint, no
 * deferred keys, or the backoff window has not elapsed).
 */
export function deferredRetryDue(
  sourceFingerprint = getMemorySourceFingerprint(),
  flagPath = MIGRATED_FLAG,
  now = Date.now(),
): string[] | null {
  const state = readMigrationState(flagPath);
  if (!state || state.sourceFingerprint !== sourceFingerprint) return null;
  const keys = state.deferredKeys ?? [];
  if (keys.length === 0) return null;
  if (typeof state.retryAfter === "number" && now < state.retryAfter) return null;
  return keys;
}

/**
 * Push the deferred-retry schedule forward without changing completion — used
 * when a targeted retry could not be recorded as complete (e.g. it surfaced a
 * genuine failure) so we do not re-attempt it on every boot.
 */
export function bumpDeferredRetry(
  sourceFingerprint: string,
  flagPath = MIGRATED_FLAG,
  now = Date.now(),
): void {
  const state = readMigrationState(flagPath);
  if (!state || state.sourceFingerprint !== sourceFingerprint) return;
  const attempts = (state.attempts ?? 0) + 1;
  const next: MigrationState = { ...state, attempts, retryAfter: now + deferralBackoffMs(attempts) };
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const temp = `${flagPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf-8");
    fs.renameSync(temp, flagPath);
  } catch { /* best effort */ }
}

/** Is the palace verified against the current durable source set? */
export function isMigrated(
  sourceFingerprint = getMemorySourceFingerprint(),
  flagPath = MIGRATED_FLAG,
): boolean {
  return readMigrationState(flagPath)?.sourceFingerprint === sourceFingerprint;
}

/**
 * Mark migration complete. Accepts a run where every discovered record is
 * verified or transiently deferred (lock contention) and nothing genuinely
 * failed. When records are deferred, persist their keys plus an exponential
 * backoff `retryAfter` so a later session retries only those keys instead of
 * re-sweeping the corpus. A genuine failure (`failed > 0`) or an incomplete
 * run is refused, so the marker never advances over lost data.
 */
export function markMigrated(
  sourceFingerprint: string,
  result: MigrationResult,
  flagPath = MIGRATED_FLAG,
  now = Date.now(),
): boolean {
  if (!isMigrationComplete(result)) return false;
  const deferred = result.deferred ?? 0;
  const prev = readMigrationState(flagPath);
  const prevAttempts = prev?.sourceFingerprint === sourceFingerprint ? prev.attempts ?? 0 : 0;
  const attempts = deferred > 0 ? prevAttempts + 1 : 0;
  try {
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    const state: MigrationState = {
      version: MIGRATION_STATE_VERSION,
      completedAt: new Date(now).toISOString(),
      sourceFingerprint,
      result,
      deferredKeys: deferred > 0 ? (result.deferredKeys ?? []) : [],
      attempts,
      ...(deferred > 0 ? { retryAfter: now + deferralBackoffMs(attempts) } : {}),
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
 * Run one bridge command synchronously, returning the full outcome so callers
 * can tell a successful `null` result (e.g. "not found") apart from a failure,
 * and transient palace-lock contention apart from a real backend error.
 */
export function runBridgeOutcome<T = unknown>(
  install: MempalaceInstall,
  palace: string,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): BridgeOutcome<T> {
  const fail = (error?: string): BridgeOutcome<T> => ({
    ok: false,
    result: null,
    error,
    transient: isTransientBridgeError(error),
  });
  const bridgePath = getBridgePath();
  if (!bridgePath) return fail("bridge script not found");
  let argsJson: string;
  try {
    argsJson = JSON.stringify(args);
  } catch {
    return fail("args not serializable");
  }
  let res;
  try {
    res = spawnSync(install.python, [bridgePath, palace, cmd, argsJson], {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (res.error) return fail(res.error.message);
  const out = (res.stdout || "").trim();
  // A non-zero exit may still carry a structured {ok:false,error} on stdout
  // (the bridge prints that then exits 1) — parse it so we can classify.
  if (out) {
    try {
      const parsed = JSON.parse(out) as BridgeResponse<T>;
      if (parsed.ok) return { ok: true, result: (parsed.result ?? null) as T | null, transient: false };
      return fail(parsed.error);
    } catch {
      return fail("bad json from bridge");
    }
  }
  return fail(res.status === 0 ? "empty output" : `bridge exited ${String(res.status)}`);
}

/**
 * Run one bridge command synchronously. Returns the parsed result, or null
 * on any failure. Prefer {@link runBridgeOutcome} when you need to distinguish
 * a "not found" null from a failure, or transient contention from a real error.
 */
export function runBridge<T = unknown>(
  install: MempalaceInstall,
  palace: string,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): T | null {
  return runBridgeOutcome<T>(install, palace, cmd, args, timeoutMs).result;
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
  return runBridgeAsyncOutcome<T>(install, palace, cmd, args, timeoutMs).then((o) => o.result);
}

/** Async twin of {@link runBridgeOutcome}. Never rejects. */
export function runBridgeAsyncOutcome<T = unknown>(
  install: MempalaceInstall,
  palace: string,
  cmd: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<BridgeOutcome<T>> {
  return new Promise((resolve) => {
    const fail = (error?: string): void =>
      resolve({ ok: false, result: null, error, transient: isTransientBridgeError(error) });
    const bridgePath = getBridgePath();
    if (!bridgePath) {
      fail("bridge script not found");
      return;
    }
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args);
    } catch {
      fail("args not serializable");
      return;
    }

    let child;
    try {
      child = spawn(install.python, [bridgePath, palace, cmd, argsJson], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    // Fire-and-forget callers (e.g. the L0 background migrate) must never keep
    // the process alive; the promise still resolves on close for awaiters.
    child.unref?.();

    let out = "";
    let settled = false;
    const finish = (outcome: BridgeOutcome<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, result: null, error: "bridge timed out", transient: false });
    }, timeoutMs);
    // Do not hold the process open purely for a background bridge call.
    timer.unref?.();

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.on("error", (err) => finish({ ok: false, result: null, error: err.message, transient: false }));
    child.on("close", () => {
      const trimmed = out.trim();
      // A non-zero exit still carries {ok:false,error} on stdout; parse first.
      if (!trimmed) {
        finish({ ok: false, result: null, error: "empty output", transient: false });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as BridgeResponse<T>;
        if (parsed.ok) {
          finish({ ok: true, result: (parsed.result ?? null) as T | null, transient: false });
        } else {
          finish({ ok: false, result: null, error: parsed.error, transient: isTransientBridgeError(parsed.error) });
        }
      } catch {
        finish({ ok: false, result: null, error: "bad json from bridge", transient: false });
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
