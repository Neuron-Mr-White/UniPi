/**
 * One-time v3 state relocation into the canonical per-workspace layout.
 *
 * Gate: ~/.unipi/state-version.json { migrated_version }. Absent or < CURRENT
 * runs the mechanical moves once, then stamps the version. Idempotent and
 * best-effort: any move that fails is logged and skipped, never fatal.
 *
 * Scope of THIS migration (the safe, unambiguous relocations):
 *   GLOBAL (cross-project, no identity needed):
 *     ~/.unipi/db/compactor/     → ~/.unipi/global/compactor/
 *     ~/.unipi/images/           → ~/.unipi/global/image/
 *     ~/.unipi/analytics/        → ~/.unipi/global/utility/analytics/
 *     ~/.unipi/cache/updater/    → ~/.unipi/global/updater/
 *   PURGE (ephemeral leak, safe to drop — sessions are dead):
 *     ~/.unipi/state/fusion/     (26 orphaned sidekick transcripts, 61 MB)
 *     ~/.unipi/trajectory/       (removed module; may already be gone)
 *
 * Identity-keyed moves (memory basename→uuid, long-horizon project state) are
 * intentionally NOT auto-remapped here: basename cannot be reversed to a
 * canonical path safely. Those modules migrate lazily on first open in their
 * own package (read old location as a fallback), which is both safer and keeps
 * this engine free of per-module knowledge.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tryRead } from "../../utils.js";

export const CURRENT_STATE_VERSION = "3.0.0";

export interface StateMigrationLogEntry {
  action: "moved" | "purged" | "skipped:missing" | "skipped:conflict" | "error";
  from: string;
  to?: string;
  detail?: string;
}

export interface StateMigrationResult {
  ran: boolean;
  version: string;
  log: StateMigrationLogEntry[];
}

function stateVersionPath(root: string): string {
  return join(root, "state-version.json");
}

function isStateMigrated(root: string): boolean {
  const raw = tryRead(stateVersionPath(root));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { migrated_version?: string };
    return typeof parsed?.migrated_version === "string" &&
      compareVersions(parsed.migrated_version, CURRENT_STATE_VERSION) >= 0;
  } catch {
    return false;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** Move a dir, merging into an existing destination rather than clobbering. */
function moveDir(from: string, to: string, log: StateMigrationLogEntry[]): void {
  if (!existsSync(from)) {
    log.push({ action: "skipped:missing", from });
    return;
  }
  try {
    if (!existsSync(to)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      log.push({ action: "moved", from, to });
      return;
    }
    // Destination exists: merge entries, keeping any that already landed.
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      const src = join(from, entry);
      const dst = join(to, entry);
      if (existsSync(dst)) {
        log.push({ action: "skipped:conflict", from: src, to: dst });
        continue;
      }
      renameSync(src, dst);
      log.push({ action: "moved", from: src, to: dst });
    }
    rmSync(from, { recursive: true, force: true });
  } catch (err) {
    log.push({ action: "error", from, to, detail: err instanceof Error ? err.message : String(err) });
  }
}

function purgeDir(from: string, log: StateMigrationLogEntry[]): void {
  if (!existsSync(from)) {
    log.push({ action: "skipped:missing", from });
    return;
  }
  try {
    rmSync(from, { recursive: true, force: true });
    log.push({ action: "purged", from });
  } catch (err) {
    log.push({ action: "error", from, detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Run the one-time state relocation. Safe to call on every startup — it
 * short-circuits once the version marker is current.
 */
export function migrateState(home: string = homedir()): StateMigrationResult {
  const root = join(home, ".unipi");
  if (isStateMigrated(root)) {
    return { ran: false, version: CURRENT_STATE_VERSION, log: [] };
  }
  const log: StateMigrationLogEntry[] = [];
  const g = (m: string) => join(root, "global", m);

  // Global relocations.
  moveDir(join(root, "db", "compactor"), g("compactor"), log);
  moveDir(join(root, "images"), g("image"), log);
  moveDir(join(root, "analytics"), join(g("utility"), "analytics"), log);
  moveDir(join(root, "cache", "updater"), g("updater"), log);

  // Ephemeral leaks: dead sessions, removed module.
  purgeDir(join(root, "state", "fusion"), log);
  purgeDir(join(root, "trajectory"), log);

  // Stamp the version so we never run again.
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      stateVersionPath(root),
      `${JSON.stringify({ migrated_version: CURRENT_STATE_VERSION, migrated_at: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch {
    // If we cannot stamp, the moves already happened idempotently; next run
    // re-attempts the (now-missing) sources as skipped:missing.
  }

  return { ran: true, version: CURRENT_STATE_VERSION, log };
}
