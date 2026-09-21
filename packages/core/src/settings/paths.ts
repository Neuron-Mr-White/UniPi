/**
 * Canonical unipi settings layout (v3).
 *
 *   global  ~/.unipi/config/<module>/config.json
 *   project <cwd>/.unipi/config/<module>/config.json   (workspace wins)
 *   ledger  ~/.unipi/config/settings-version.json
 *   backup  ~/.unipi/config/.backup/<migration-id>/…
 *
 * One uniform rule for every module — including project overrides, which
 * previously used three different shapes (compactor.json, fusion-preset.json,
 * config/background-tasks.json).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Resolved at call time — module-level path constants break test isolation. */
export function unipiConfigRoot(): string {
  return join(homedir(), ".unipi", "config");
}

export function globalSettingsPath(namespace: string, file = "config.json"): string {
  return join(unipiConfigRoot(), namespace, file);
}

export function projectSettingsPath(cwd: string, namespace: string, file = "config.json"): string {
  return join(cwd, ".unipi", "config", namespace, file);
}

export function migrationLedgerPath(): string {
  return join(unipiConfigRoot(), "settings-version.json");
}

export function migrationBackupDir(migrationId: string): string {
  return join(unipiConfigRoot(), ".backup", migrationId);
}
