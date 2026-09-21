/**
 * v2.x → v3 settings migration.
 *
 * Gate: a `migrated_version` marker. Absent or < CURRENT → migrate once,
 * then the marker reads "3.0.0" forever after (one file read per process,
 * no startup effect — the check is called lazily by the engine's first
 * settings access). Project-scope moves carry their own per-project marker
 * under <cwd>/.unipi/config/, so a project that never opens never migrates.
 *
 * Pre-3.0.0 layouts (all still present in the wild):
 *   A  ~/.pi/agent/settings.json → unipi.<module> keys
 *      (askUser, footer, infoScreen, longHorizon)
 *   B  ~/.unipi/config/<module>/config.json — already canonical, stays
 *   C  project overrides in three shapes:
 *        <cwd>/.unipi/config/compactor.json          (flat)
 *        <cwd>/.unipi/fusion-preset.json             (other dir, flat)
 *        <cwd>/.unipi/config/background-tasks.json   (flat in config/)
 *
 * Safety: backup-first (.backup/pre-3.0.0/), conflict:kept-existing
 * (never clobber), delete-only-after-verify, ledgered, idempotent.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalSettingsPath, migrationBackupDir, migrationLedgerPath, projectSettingsRoot, projectLedgerPath } from "./paths.js";
import { compareVersions, tryRead, writeJson } from "../../utils.js";

export const CURRENT_SETTINGS_VERSION = "3.0.0";

export interface MigrationLedger {
  /** Semver of the layout this scope is on; >= CURRENT skips import. */
  readonly migrated_version: string;
  /**
   * False after import (legacy copies remain — v2 installs keep working).
   * True after finalize (legacy stripped/deleted — the explicit step).
   */
  readonly finalized: boolean;
  readonly appliedAt: string;
  readonly log: MigrationLogEntry[];
}

export interface MigrationLogEntry {
  action: "copied" | "moved" | "stripped-key" | "conflict:kept-existing" | "skipped:missing" | "removed-legacy";
  from: string;
  to?: string;
}

export interface MigrationResult {
  ran: boolean;
  reason?: "already-migrated" | "nothing-to-migrate";
  ledger: MigrationLedger;
}

interface Move {
  from: string;
  to: string;
}

/** Modules stored as unipi.<module> keys in pi's settings.json (layout A). */
const A_KEY_MODULES: ReadonlyArray<{ namespace: string; key: string }> = [
  { namespace: "ask-user", key: "askUser" },
  { namespace: "footer", key: "footer" },
  { namespace: "info-screen", key: "infoScreen" },
  { namespace: "long-horizon", key: "longHorizon" },
];

/** Project override files that need shape unification (layout C). */
const C_OVERRIDE_MOVES: ReadonlyArray<{ namespace: string; from: string }> = [
  { namespace: "compactor", from: join(".unipi", "config", "compactor.json") },
  { namespace: "fusion", from: join(".unipi", "fusion-preset.json") },
  { namespace: "background-tasks", from: join(".unipi", "config", "background-tasks.json") },
];

/** Semver gate compare — core's compareVersions (pre-release aware). */

/** True when this scope's marker says it is on CURRENT or newer. */
export function isMigrated(ledgerPath: string): boolean {
  const raw = tryRead(ledgerPath);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as MigrationLedger;
    return typeof parsed?.migrated_version === "string" &&
      compareVersions(parsed.migrated_version, CURRENT_SETTINGS_VERSION) >= 0;
  } catch {
    return false;
  }
}

function readLedger(ledgerPath: string): MigrationLedger | null {
  const raw = tryRead(ledgerPath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MigrationLedger;
    return typeof parsed?.migrated_version === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Resolved at call time — HOME flips between tests (and users). */
function piSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

function ensureParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

/** Copy a file into the backup dir, preserving its absolute path shape. */
function backupFile(backupDir: string, file: string): void {
  const marker = file.startsWith(homedir()) ? file.slice(homedir().length) : `/abs${file}`;
  const target = join(backupDir, marker.replace(/^\//, ""));
  ensureParent(target);
  cpSync(file, target, { force: true });
}

/**
 * IMPORT (copy-only): legacy → target, legacy left in place. v2 installs
 * sharing this machine keep working off the originals.
 */
function copyWithSafety(move: Move, log: MigrationLogEntry[]): boolean {
  if (!existsSync(move.from)) {
    log.push({ action: "skipped:missing", from: move.from });
    return false;
  }
  if (existsSync(move.to)) {
    log.push({ action: "conflict:kept-existing", from: move.from, to: move.to });
    return false;
  }
  ensureParent(move.to);
  writeFileSync(move.to, readFileSync(move.from, "utf-8"), "utf-8");
  log.push({ action: "copied", from: move.from, to: move.to });
  return true;
}

/**
 * FINALIZE (destructive): delete a legacy file after a verified backup.
 * Only called from the explicit finalize entry points.
 */
function removeLegacyAfterBackup(file: string, backupDir: string, log: MigrationLogEntry[]): void {
  if (!existsSync(file)) return;
  backupFile(backupDir, file);
  const content = readFileSync(file, "utf-8");
  const backupCopy = join(backupDir, file.startsWith(homedir()) ? file.slice(homedir().length) : join("abs", file));
  if (existsSync(backupCopy) && tryRead(backupCopy) === content) {
    rmSync(file);
    log.push({ action: "removed-legacy", from: file });
  }
}

/**
 * IMPORT the global scope (copy-only). Layout A keys are COPIED into module
 * dirs; pi's settings.json and its unipi.* keys are left untouched so v2
 * installs sharing this machine keep working. Idempotent via the marker.
 */
export function importGlobalScope(): MigrationResult {
  const ledgerPath = migrationLedgerPath();
  const existing = readLedger(ledgerPath);
  if (existing && compareVersions(existing.migrated_version, CURRENT_SETTINGS_VERSION) >= 0) {
    return { ran: false, reason: "already-migrated", ledger: existing };
  }

  const log: MigrationLogEntry[] = [];
  let touched = false;

  const piSettingsFile = piSettingsPath();
  if (existsSync(piSettingsFile)) {
    try {
      const raw = JSON.parse(readFileSync(piSettingsFile, "utf-8")) as Record<string, unknown>;
      const unipi = raw.unipi;
      if (unipi && typeof unipi === "object") {
        for (const { namespace, key } of A_KEY_MODULES) {
          const value = (unipi as Record<string, unknown>)[key];
          if (value === undefined) {
            log.push({ action: "skipped:missing", from: `pi-settings:unipi.${key}` });
            continue;
          }
          const target = globalSettingsPath(namespace);
          if (existsSync(target)) {
            log.push({ action: "conflict:kept-existing", from: `pi-settings:unipi.${key}`, to: target });
            continue;
          }
          ensureParent(target);
          writeJson(target, value);
          log.push({ action: "copied", from: `pi-settings:unipi.${key}`, to: target });
          touched = true;
        }
      }
    } catch {
      // Unreadable pi settings: leave untouched; module defaults apply.
    }
  }

  const ledger: MigrationLedger = {
    migrated_version: CURRENT_SETTINGS_VERSION,
    finalized: false,
    appliedAt: new Date().toISOString(),
    log,
  };
  writeJson(ledgerPath, ledger);
  if (!touched && log.length === 0) {
    return { ran: false, reason: "nothing-to-migrate", ledger };
  }
  return { ran: true, ledger };
}

/**
 * FINALIZE the global scope (explicit, destructive): backup + strip the
 * unipi.* keys we own from pi's settings.json. Legacy project override
 * files are NOT touched here (they belong to their project finalize).
 */
export function finalizeGlobalScope(): { ran: boolean; ledger: MigrationLedger } {
  const ledgerPath = migrationLedgerPath();
  const existing = readLedger(ledgerPath);
  if (existing?.finalized) {
    return { ran: false, ledger: existing };
  }
  const backupDir = migrationBackupDir("pre-3.0.0");
  mkdirSync(backupDir, { recursive: true });
  const log: MigrationLogEntry[] = [];

  const piSettingsFile = piSettingsPath();
  if (existsSync(piSettingsFile)) {
    try {
      backupFile(backupDir, piSettingsFile);
      const raw = JSON.parse(readFileSync(piSettingsFile, "utf-8")) as Record<string, unknown>;
      const unipi = raw.unipi;
      if (unipi && typeof unipi === "object") {
        const unipiRecord = unipi as Record<string, unknown>;
        const keysSeen = new Set<string>();
        for (const { key } of A_KEY_MODULES) {
          if (unipiRecord[key] !== undefined) keysSeen.add(key);
        }
        if (keysSeen.size > 0) {
          for (const key of keysSeen) delete unipiRecord[key];
          if (Object.keys(unipiRecord).length === 0) delete raw.unipi;
          writeFileSync(piSettingsFile, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          log.push({ action: "stripped-key", from: `pi-settings:unipi (${[...keysSeen].join(", ")})` });
        }
      }
    } catch {
      // Unreadable: nothing to strip.
    }
  }

  const ledger: MigrationLedger = {
    migrated_version: CURRENT_SETTINGS_VERSION,
    finalized: true,
    appliedAt: new Date().toISOString(),
    log,
  };
  writeJson(ledgerPath, ledger);
  return { ran: true, ledger };
}

/**
 * IMPORT the project scope (copy-only): legacy override shapes are COPIED
 * into <module>/config.json; the originals remain for v2 sessions in this
 * project. Idempotent via the project marker.
 */
export function importProjectScope(cwd: string): MigrationResult {
  const ledgerPath = projectLedgerPath(cwd);
  const existing = readLedger(ledgerPath);
  if (existing && compareVersions(existing.migrated_version, CURRENT_SETTINGS_VERSION) >= 0) {
    return { ran: false, reason: "already-migrated", ledger: existing };
  }

  const log: MigrationLogEntry[] = [];
  let touched = false;
  for (const { namespace, from } of C_OVERRIDE_MOVES) {
    if (copyWithSafety({ from: join(cwd, from), to: join(projectSettingsRoot(cwd), namespace, "config.json") }, log)) {
      touched = true;
    }
  }

  const ledger: MigrationLedger = {
    migrated_version: CURRENT_SETTINGS_VERSION,
    finalized: false,
    appliedAt: new Date().toISOString(),
    log,
  };
  writeJson(ledgerPath, ledger);
  if (!touched && log.length === 0) {
    return { ran: false, reason: "nothing-to-migrate", ledger };
  }
  return { ran: true, ledger };
}

/**
 * FINALIZE the project scope (explicit, destructive): backup + delete the
 * legacy override files after verified copies exist at the new locations.
 */
export function finalizeProjectScope(cwd: string): { ran: boolean; ledger: MigrationLedger } {
  const ledgerPath = projectLedgerPath(cwd);
  const existing = readLedger(ledgerPath);
  if (existing?.finalized) {
    return { ran: false, ledger: existing };
  }
  const backupDir = join(projectSettingsRoot(cwd), ".backup", "pre-3.0.0");
  mkdirSync(backupDir, { recursive: true });
  const log: MigrationLogEntry[] = [];

  for (const { namespace, from } of C_OVERRIDE_MOVES) {
    const legacyFile = join(cwd, from);
    const target = join(projectSettingsRoot(cwd), namespace, "config.json");
    // Only remove when the new location actually holds content.
    if (existsSync(legacyFile) && existsSync(target)) {
      removeLegacyAfterBackup(legacyFile, backupDir, log);
    } else if (existsSync(legacyFile)) {
      log.push({ action: "conflict:kept-existing", from: legacyFile, to: target });
    }
  }

  const ledger: MigrationLedger = {
    migrated_version: CURRENT_SETTINGS_VERSION,
    finalized: true,
    appliedAt: new Date().toISOString(),
    log,
  };
  writeJson(ledgerPath, ledger);
  return { ran: true, ledger };
}
