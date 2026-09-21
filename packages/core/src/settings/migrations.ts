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
  /** Semver of the layout this scope is on; >= CURRENT skips migration. */
  readonly migrated_version: string;
  readonly appliedAt: string;
  readonly log: MigrationLogEntry[];
}

export interface MigrationLogEntry {
  action: "moved" | "stripped-key" | "conflict:kept-existing" | "skipped:missing" | "removed-legacy";
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

function moveWithSafety(move: Move, backupDir: string, log: MigrationLogEntry[]): boolean {
  if (!existsSync(move.from)) {
    log.push({ action: "skipped:missing", from: move.from });
    return false;
  }
  backupFile(backupDir, move.from);
  if (existsSync(move.to)) {
    log.push({ action: "conflict:kept-existing", from: move.from, to: move.to });
    return false;
  }
  ensureParent(move.to);
  const content = readFileSync(move.from, "utf-8");
  writeFileSync(move.to, content, "utf-8");
  if (tryRead(move.to) === content) {
    rmSync(move.from);
    log.push({ action: "moved", from: move.from, to: move.to });
    log.push({ action: "removed-legacy", from: move.from });
    return true;
  }
  log.push({ action: "conflict:kept-existing", from: move.from, to: move.to });
  return false;
}

function writeLedger(path: string, log: MigrationLogEntry[]): void {
  writeJson(path, {
    migrated_version: CURRENT_SETTINGS_VERSION,
    appliedAt: new Date().toISOString(),
    log,
  } satisfies MigrationLedger);
}

/**
 * Migrate the GLOBAL scope (layout A keys out of pi's settings.json).
 * Gated by ~/.unipi/config/settings-version.json → migrated_version.
 */
export function migrateGlobalScope(): MigrationResult {
  const ledgerPath = migrationLedgerPath();
  if (isMigrated(ledgerPath)) {
    return {
      ran: false,
      reason: "already-migrated",
      ledger: {
        migrated_version: CURRENT_SETTINGS_VERSION,
        appliedAt: "",
        log: [],
      },
    };
  }

  const backupDir = migrationBackupDir("pre-3.0.0");
  const log: MigrationLogEntry[] = [];
  let touched = false;
  mkdirSync(backupDir, { recursive: true });

  const piSettingsFile = piSettingsPath();
  if (existsSync(piSettingsFile)) {
    backupFile(backupDir, piSettingsFile);
    try {
      const raw = JSON.parse(readFileSync(piSettingsFile, "utf-8")) as Record<string, unknown>;
      const unipi = raw.unipi;
      if (unipi && typeof unipi === "object") {
        const unipiRecord = unipi as Record<string, unknown>;
        const keysSeen = new Set<string>();
        for (const { namespace, key } of A_KEY_MODULES) {
          const value = unipiRecord[key];
          if (value === undefined) continue;
          keysSeen.add(key);
          const target = globalSettingsPath(namespace);
          if (existsSync(target)) {
            log.push({ action: "conflict:kept-existing", from: `pi-settings:unipi.${key}`, to: target });
            continue;
          }
          ensureParent(target);
          writeJson(target, value);
          log.push({ action: "moved", from: `pi-settings:unipi.${key}`, to: target });
          touched = true;
        }
        // Strip only the keys we own; leave anything unknown in place.
        if (keysSeen.size > 0) {
          for (const key of keysSeen) delete unipiRecord[key];
          if (Object.keys(unipiRecord).length === 0) delete raw.unipi;
          writeFileSync(piSettingsFile, JSON.stringify(raw, null, 2) + "\n", "utf-8");
          log.push({ action: "stripped-key", from: `pi-settings:unipi (${[...keysSeen].join(", ")})` });
        }
      }
    } catch {
      // Unreadable pi settings: leave untouched; module defaults apply.
    }
  }

  writeLedger(ledgerPath, log);
  if (!touched && log.length === 0) {
    return {
      ran: false,
      reason: "nothing-to-migrate",
      ledger: { migrated_version: CURRENT_SETTINGS_VERSION, appliedAt: new Date().toISOString(), log },
    };
  }
  return {
    ran: true,
    ledger: { migrated_version: CURRENT_SETTINGS_VERSION, appliedAt: new Date().toISOString(), log },
  };
}

/**
 * Migrate the PROJECT scope (layout C override shapes). Gated by its own
 * marker at <cwd>/.unipi/config/settings-version.json — a project that
 * never opens never migrates.
 */
export function migrateProjectScope(cwd: string): MigrationResult {
  const ledgerPath = projectLedgerPath(cwd);
  if (isMigrated(ledgerPath)) {
    return {
      ran: false,
      reason: "already-migrated",
      ledger: { migrated_version: CURRENT_SETTINGS_VERSION, appliedAt: "", log: [] },
    };
  }

  const backupDir = join(projectSettingsRoot(cwd), ".backup", "pre-3.0.0");
  const log: MigrationLogEntry[] = [];
  let touched = false;
  mkdirSync(backupDir, { recursive: true });

  for (const { namespace, from } of C_OVERRIDE_MOVES) {
    const moved = moveWithSafety(
      { from: join(cwd, from), to: join(projectSettingsRoot(cwd), namespace, "config.json") },
      backupDir,
      log,
    );
    if (moved) touched = true;
  }

  writeLedger(ledgerPath, log);
  if (!touched && log.length === 0) {
    return {
      ran: false,
      reason: "nothing-to-migrate",
      ledger: { migrated_version: CURRENT_SETTINGS_VERSION, appliedAt: new Date().toISOString(), log },
    };
  }
  return {
    ran: true,
    ledger: { migrated_version: CURRENT_SETTINGS_VERSION, appliedAt: new Date().toISOString(), log },
  };
}
