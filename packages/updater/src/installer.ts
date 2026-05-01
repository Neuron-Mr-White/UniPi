/**
 * @pi-unipi/updater — Update installer
 *
 * Wraps child_process.exec for installing updates via pi CLI.
 * Emits UPDATE_APPLIED or UPDATE_ERROR events.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { getPackageVersion, emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";
import type { InstallResult } from "../types.js";

const execAsync = promisify(exec);

/** Timeout for the install command (60 seconds) */
const INSTALL_TIMEOUT_MS = 60000;

/**
 * Install the latest version of @pi-unipi/unipi.
 * Uses pi CLI: `pi install npm:@pi-unipi/unipi`
 * Returns structured result with success/failure info.
 */
export async function installUpdate(
  pi?: { events: { emit: (name: string, payload: unknown) => void } },
): Promise<InstallResult> {
  const installedBefore = getPackageVersion(
    new URL("../../..", import.meta.url).pathname,
  );

  try {
    const { stdout, stderr } = await execAsync(
      "pi install npm:@pi-unipi/unipi",
      {
        timeout: INSTALL_TIMEOUT_MS,
        env: { ...process.env },
      },
    );

    // Get new version after install
    const installedAfter = getPackageVersion(
      new URL("../../..", import.meta.url).pathname,
    );

    const result: InstallResult = {
      success: true,
      version: installedAfter,
    };

    // Emit success event
    if (pi) {
      emitEvent(pi, UNIPI_EVENTS.UPDATE_APPLIED, {
        previousVersion: installedBefore,
        newVersion: installedAfter,
      });
    }

    return result;
  } catch (err: any) {
    const errorMessage = err.stderr || err.message || "Unknown install error";

    // Emit error event
    if (pi) {
      emitEvent(pi, UNIPI_EVENTS.UPDATE_ERROR, {
        error: errorMessage,
        phase: "install",
      });
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}
