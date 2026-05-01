/**
 * Status bar feedback helper using ctx.ui.setStatus() with auto-clear.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { STATUS_SUCCESS_MS, STATUS_ERROR_MS } from "./types.ts";

const STATUS_KEY = "input-shortcuts";

/** Show a success status message with auto-clear. */
export function showSuccess(ctx: ExtensionContext, text: string, durationMs = STATUS_SUCCESS_MS): void {
  showStatus(ctx, text, durationMs);
}

/** Show an error status message with auto-clear. */
export function showError(ctx: ExtensionContext, text: string, durationMs = STATUS_ERROR_MS): void {
  showStatus(ctx, text, durationMs);
}

/** Show status text with auto-clear after duration. */
export function showStatus(ctx: ExtensionContext, text: string, durationMs: number): void {
  ctx.ui.setStatus(STATUS_KEY, text);
  setTimeout(() => {
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      // Context may be gone — ignore
    }
  }, durationMs);
}

/** Clear the status bar entry immediately. */
export function clearStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
