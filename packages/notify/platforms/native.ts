/**
 * @pi-unipi/notify — Native OS notification platform
 *
 * Wraps node-notifier for cross-platform desktop notifications.
 * Windows: SnoreToast (no admin required)
 * macOS: terminal-notifier
 * Linux: notify-send / libnotify
 */

import notifier from "node-notifier";
import { isWindowFocused } from "./focus.js";

/** Options for native notification */
export interface NativeNotificationOptions {
  /** Windows appID to show instead of "SnoreToast" */
  windowsAppId?: string;
  /**
   * When true, suppresses the notification if the terminal window is
   * the foreground (active) window. Only effective on platforms where
   * `isWindowFocused` is implemented (currently Windows).
   */
  suppressWhenFocused?: boolean;
}

/**
 * Thrown by sendNativeNotification when the notification was suppressed
 * because suppressWhenFocused is set and the terminal window is focused.
 *
 * Callers should catch this and treat it as intentional suppression,
 * NOT as a send failure.
 */
export class SuppressedError extends Error {
  constructor() {
    super("Notification suppressed: terminal window is focused");
    this.name = "SuppressedError";
  }
}

/**
 * Send a native OS notification.
 *
 * When `suppressWhenFocused` is true and `isWindowFocused()` returns true
 * (i.e. the terminal is the foreground window), the notification is
 * suppressed and the promise rejects with SuppressedError.
 *
 * Resolves when notification is shown, rejects with SuppressedError on
 * suppression or with a standard Error on failure.
 */
export async function sendNativeNotification(
  title: string,
  message: string,
  options?: NativeNotificationOptions
): Promise<void> {
  // Suppress if the terminal window is currently focused
  if (options?.suppressWhenFocused && await isWindowFocused()) {
    throw new SuppressedError();
  }

  return new Promise((resolve, reject) => {
    notifier.notify(
      {
        title,
        message,
        appID: options?.windowsAppId,
      },
      (err: Error | null) => {
        if (err) {
          reject(
            new Error(
              `Native notification failed: ${err.message}`
            )
          );
        } else {
          resolve();
        }
      }
    );
  });
}
