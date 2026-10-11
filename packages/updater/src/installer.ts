/**
 * @pi-unipi/updater — Update installer
 *
 * Wraps child_process.exec for installing updates via pi CLI.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getInstalledPackageVersion } from "@pi-unipi/core";
import { installSpec } from "./channel.js";
import type { InstallResult } from "../types.js";

const execAsync = promisify(exec);

/** Timeout for the install command (60 seconds) */
const INSTALL_TIMEOUT_MS = 60000;

/**
 * Install the newest @pi-unipi/unipi on `channel`.
 * Uses pi CLI: `pi install npm:@pi-unipi/unipi[@<channel>]`
 * Returns structured result with success/failure info.
 */
export async function installUpdate(channel = "latest"): Promise<InstallResult> {
  const thisDir = dirname(dirname(fileURLToPath(import.meta.url)));

  try {
    // Install from the same channel the check used — a bare spec would pull
    // `latest` and downgrade an alpha install (UNI-262).
    await execAsync(
      `pi install ${installSpec(channel)}`,
      {
        timeout: INSTALL_TIMEOUT_MS,
        env: { ...process.env },
      },
    );

    // Get new version after install
    const installedAfter = getInstalledPackageVersion(thisDir, "@pi-unipi/unipi");

    return {
      success: true,
      version: installedAfter,
    };
  } catch (err: unknown) {
    const errorMessage = (err instanceof Error && 'stderr' in err ? String((err as Error & { stderr?: string }).stderr) : undefined)
      || (err instanceof Error ? err.message : undefined)
      || String(err)
      || "Unknown install error";

    return {
      success: false,
      error: errorMessage,
    };
  }
}
