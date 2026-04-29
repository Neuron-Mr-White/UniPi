/**
 * @pi-unipi/notify — Command registration
 *
 * Registers slash commands for notification configuration and testing.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";
import { NOTIFY_COMMANDS } from "@pi-unipi/core";
import { NotifySettingsOverlay } from "./tui/settings-overlay.js";
import { GotifySetupOverlay } from "./tui/gotify-setup.js";
import { TelegramSetupOverlay } from "./tui/telegram-setup.js";
import { NtfySetupOverlay } from "./tui/ntfy-setup.js";
import { RecapModelSelectorOverlay } from "./tui/recap-model-selector.js";
import { loadConfig } from "./settings.js";
import { sendNativeNotification } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";

/**
 * Register notify commands.
 */
export function registerNotifyCommands(pi: ExtensionAPI): void {
  // /unipi:notify-settings — Opens settings TUI overlay
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.SETTINGS}`,
    {
      description: "Configure notification platforms and events",
      handler: async (_args: string, ctx: ExtensionContext) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Settings require an interactive UI.", "warning");
          return;
        }

        ctx.ui.custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            const overlay = new NotifySettingsOverlay();
            overlay.setTheme(theme);
            overlay.onClose = () => done(undefined);
            overlay.requestRender = () => tui.requestRender();
            overlay.onOpenModelSelector = () => {
              // Open model selector as nested overlay
              ctx.ui.custom(
                (innerTui: any, innerTheme: any, _innerKb: any, innerDone: any) => {
                  const selector = new RecapModelSelectorOverlay();
                  selector.setTheme(innerTheme);
                  selector.onClose = () => innerDone(undefined);
                  selector.requestRender = () => innerTui.requestRender();
                  return {
                    render: (w: number) => selector.render(w),
                    invalidate: () => selector.invalidate(),
                    handleInput: (data: string) => {
                      selector.handleInput(data);
                      innerTui.requestRender();
                    },
                  };
                },
                {
                  overlay: true,
                  overlayOptions: {
                    width: "60%",
                    minWidth: 40,
                    anchor: "center",
                    margin: 4,
                  },
                }
              );
            };
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (data: string) => {
                overlay.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 60,
              anchor: "center",
              margin: 2,
            },
          }
        );
      },
    }
  );

  // /unipi:notify-recap-model — Open recap model selector directly
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.RECAP_MODEL}`,
    {
      description: "Select model for notification recaps",
      handler: async (_args: string, ctx: ExtensionContext) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Model selector requires an interactive UI.", "warning");
          return;
        }

        ctx.ui.custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            const overlay = new RecapModelSelectorOverlay();
            overlay.setTheme(theme);
            overlay.onClose = () => done(undefined);
            overlay.requestRender = () => tui.requestRender();
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (data: string) => {
                overlay.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "60%",
              minWidth: 40,
              anchor: "center",
              margin: 4,
            },
          }
        );
      },
    }
  );

  // /unipi:notify-set-gotify — Interactive Gotify setup
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.SET_GOTIFY}`,
    {
      description: "Set up Gotify push notifications with connection test",
      handler: async (_args: string, ctx: ExtensionContext) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Gotify setup requires an interactive UI.", "warning");
          return;
        }

        ctx.ui.custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            const overlay = new GotifySetupOverlay();
            overlay.setTheme(theme);
            overlay.onClose = () => done(undefined);
            overlay.requestRender = () => tui.requestRender();
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (data: string) => {
                overlay.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 60,
              anchor: "center",
              margin: 2,
            },
          }
        );
      },
    }
  );

  // /unipi:notify-set-tg — Interactive Telegram setup
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.SET_TG}`,
    {
      description: "Set up Telegram bot notifications with auto-detection",
      handler: async (_args: string, ctx: ExtensionContext) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Telegram setup requires an interactive UI.", "warning");
          return;
        }

        ctx.ui.custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            const overlay = new TelegramSetupOverlay();
            overlay.setTheme(theme);
            overlay.onClose = () => done(undefined);
            overlay.requestRender = () => tui.requestRender();
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (data: string) => {
                overlay.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 60,
              anchor: "center",
              margin: 2,
            },
          }
        );
      },
    }
  );

  // /unipi:notify-set-ntfy — Interactive ntfy setup
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.SET_NTFY}`,
    {
      description: "Set up ntfy push notifications with connection test",
      handler: async (_args: string, ctx: ExtensionContext) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("ntfy setup requires an interactive UI.", "warning");
          return;
        }

        ctx.ui.custom(
          (tui: any, theme: any, _keybindings: any, done: any) => {
            const overlay = new NtfySetupOverlay();
            overlay.setTheme(theme);
            overlay.onClose = () => done(undefined);
            overlay.requestRender = () => tui.requestRender();
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (data: string) => {
                overlay.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 60,
              anchor: "center",
              margin: 2,
            },
          }
        );
      },
    }
  );

  // /unipi:notify-test — Send test notification to all enabled platforms
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.TEST}`,
    {
      description: "Send a test notification to all enabled platforms",
      handler: async (_args: string, ctx: ExtensionContext) => {
        const config = loadConfig();
        const title = "Pi — Test Notification";
        const message = `Test notification sent at ${new Date().toLocaleTimeString()}`;
        const results: string[] = [];

        // Native
        if (config.native.enabled) {
          try {
            await sendNativeNotification(title, message, {
              windowsAppId: config.native.windowsAppId,
            });
            results.push("✓ Native: sent");
          } catch (err) {
            results.push(
              `✗ Native: ${err instanceof Error ? err.message : "failed"}`
            );
          }
        }

        // Gotify
        if (config.gotify.enabled && config.gotify.serverUrl && config.gotify.appToken) {
          try {
            await sendGotifyNotification(
              config.gotify.serverUrl,
              config.gotify.appToken,
              title,
              message,
              config.gotify.priority
            );
            results.push("✓ Gotify: sent");
          } catch (err) {
            results.push(
              `✗ Gotify: ${err instanceof Error ? err.message : "failed"}`
            );
          }
        }

        // Telegram
        if (config.telegram.enabled && config.telegram.botToken && config.telegram.chatId) {
          try {
            await sendTelegramNotification(
              config.telegram.botToken,
              config.telegram.chatId,
              title,
              message
            );
            results.push("✓ Telegram: sent");
          } catch (err) {
            results.push(
              `✗ Telegram: ${err instanceof Error ? err.message : "failed"}`
            );
          }
        }

        // ntfy
        if (config.ntfy.enabled && config.ntfy.serverUrl && config.ntfy.topic) {
          try {
            await sendNtfyNotification(
              config.ntfy.serverUrl,
              config.ntfy.topic,
              title,
              message,
              config.ntfy.priority,
              config.ntfy.token
            );
            results.push("✓ ntfy: sent");
          } catch (err) {
            results.push(
              `✗ ntfy: ${err instanceof Error ? err.message : "failed"}`
            );
          }
        }

        if (results.length === 0) {
          ctx.ui.notify("No platforms enabled. Use /unipi:notify-settings first.", "warning");
        } else {
          ctx.ui.notify(`Test results:\n${results.join("\n")}`, "info");
        }
      },
    }
  );
}
