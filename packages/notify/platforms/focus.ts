/**
 * @pi-unipi/notify — Focus detection abstraction
 *
 * Unified interface for checking whether the terminal window is the
 * foreground (active) window. Platform-specific implementations are
 * dispatched based on process.platform.
 *
 * Currently implemented:
 *   - Windows (win32): calls focus-win.ts
 *
 * Unimplemented platforms always return false (no suppression).
 */

import { isWindowFocusedOnWindows } from "./focus-win.js";

/**
 * Check whether the current terminal/console window is the foreground
 * (active) window. Used by sendNativeNotification to optionally
 * suppress notifications when the user is already looking at the screen.
 *
 * @returns true if the terminal is the foreground window, false otherwise.
 *          On unimplemented platforms, always returns false.
 */
export async function isWindowFocused(): Promise<boolean> {
  switch (process.platform) {
    case "win32":
      return await isWindowFocusedOnWindows();
    // TODO: macOS — use osascript to check frontmost application
    // TODO: Linux — use xdotool (X11) or per-compositor tool (Wayland)
    default:
      return false;
  }
}
