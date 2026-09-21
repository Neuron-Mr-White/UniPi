/**
 * v2.x → v3 settings migration.
 *
 * Pre-3.0.0 layouts (all still present in the wild):
 *   A  ~/.pi/agent/settings.json → unipi.<module> keys
 *      (askUser, footer, infoScreen, longHorizon)
 *   B  ~/.unipi/config/<module>/config.json — already canonical, stays
 *   C  project overrides in three shapes:
 *        <cwd>/.unipi/config/compactor.json          (flat)
 *        <cwd>/.unipi/fusion-preset.json             (other dir, flat)
 *        <cwd>/.unipi/config/background-tasks.json   (flat in config/)
 *        <cwd>/.unipi/config/notify/ntfy.json        (already shaped)
 *
 * migrateToV3Layout moves A into module dirs, unifies C into
 * <cwd>/.unipi/config/<module>/config.json, strips the unipi key from pi's
 * settings.json, and records everything in the ledger. Backup-first,
 * conflict-kept-existing (never clobber), delete-only-after-verify, and any
 * failure leaves legacy sources untouched.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalSettingsPath, migrationBackupDir, migrationLedgerPath, projectSettingsPath } from "./paths.js";
import { tryRead, writeJson } from "../../utils.js";

export const CURRENT_SETTINGS_VERSION = 3;

export interface MigrationLedger {
  version: number;
  appliedAt: string;
  log: MigrationLogEntry[];
}

export interface MigrationLogEntry {
  action: "moved" | "stripped-key" | "conflict:kept-existing" | "skipped:missing" | "removed-legacy";
  from: string;
  to?: string;
}

export interface MigrationResult {
  ran: boolean;
  reason?: "already-applied" | "nothing-to-migrate";
  ledger: MigrationLedger;
}

interface Move {
  from: string;
  to: string;
}

/** Resolved at call time — HOME flips between tests (and users). */
function piSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
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

export function readLedger(): MigrationLedger | null {
  const raw = tryRead(migrationLedgerPath());
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MigrationLedger;
    if (typeof parsed?.version === "number" && Array.isArray(parsed.log)) return parsed;
  } catch {
    // corrupt ledger = absent
  }
  return null;
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
  // Verify, then remove the legacy file.
  if (tryRead(move.to) === content) {
    rmSync(move.from);
    log.push({ action: "moved", from: move.from, to: move.to });
    log.push({ action: "removed-legacy", from: move.from });
    return true;
  }
  // Write verify failed — leave both, log the conflict.
  log.push({ action: "conflict:kept-existing", from: move.from, to: move.to });
  return false;
}

export function migrateToV3Layout(cwd: string): MigrationResult {
  const existing = readLedger();
  if (existing?.version === CURRENT_SETTINGS_VERSION) {
    return { ran: false, reason: "already-applied", ledger: existing };
  }

  const migrationId = "pre-3.0.0";
  const backupDir = migrationBackupDir(migrationId);
  const log: MigrationLogEntry[] = [];
  let touched = false;

  mkdirSync(backupDir, { recursive: true });

  // ── Layout A: unipi.<module> keys out of pi's settings.json ───────────
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

  // ── Layout C: unify project override shapes ───────────────────────────
  for (const { namespace, from } of C_OVERRIDE_MOVES) {
    const moved = moveWithSafety(
      { from: join(cwd, from), to: projectSettingsPath(cwd, namespace) },
      backupDir,
      log,
    );
    if (moved) touched = true;
  }

  const ledger: MigrationLedger = {
    version: CURRENT_SETTINGS_VERSION,
    appliedAt: new Date().toISOString(),
    log,
  };
  writeJson(migrationLedgerPath(), ledger);
  if (!touched && log.length === 0) {
    return { ran: false, reason: "nothing-to-migrate", ledger };
  }
  return { ran: true, ledger };
}
