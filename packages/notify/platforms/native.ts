/**
 * @pi-unipi/notify — Native OS notification platform
 *
 * Wraps node-notifier for cross-platform desktop notifications.
 * Windows: SnoreToast (no admin required)
 * macOS: terminal-notifier
 * Linux: notify-send / libnotify
 */

import notifier from "node-notifier";

/** Options for native notification */
export interface NativeNotificationOptions {
  /** Windows appID to show instead of "SnoreToast" */
  windowsAppId?: string;
}

/**
 * Send a native OS notification.
 * Resolves when notification is shown, rejects on error.
 */
export async function sendNativeNotification(
  title: string,
  message: string,
  options?: NativeNotificationOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    notifier.notify(
      {
        title,
        message,
        appID: options?.windowsAppId,
      },
      (err) => {
        if (err) {
          reject(
            new Error(
              `Native notification failed: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        } else {
          resolve();
        }
      }
    );
  });
}
