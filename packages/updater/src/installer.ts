/**
 * @pi-unipi/updater — Update installer
 *
 * Wraps child_process.exec for installing updates via pi CLI.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { getInstalledPackageVersion } from "@pi-unipi/core";
import type { InstallResult } from "../types.js";

const execAsync = promisify(exec);

/** Timeout for the install command (60 seconds) */
const INSTALL_TIMEOUT_MS = 60000;

/**
 * Install the latest version of @pi-unipi/unipi.
 * Uses pi CLI: `pi install npm:@pi-unipi/unipi`
 * Returns structured result with success/failure info.
 */
export async function installUpdate(): Promise<InstallResult> {
  const thisDir = new URL("..", import.meta.url).pathname;

  try {
    await execAsync(
      "pi install npm:@pi-unipi/unipi",
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
