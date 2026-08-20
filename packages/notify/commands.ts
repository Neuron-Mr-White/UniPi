/**
 * @pi-unipi/notify — Command registration
 *
 * Registers slash commands for notification configuration and testing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";
import { NOTIFY_COMMANDS } from "@pi-unipi/core";
import { NotifySettingsOverlay } from "./tui/settings-overlay.js";
import { GotifySetupOverlay } from "./tui/gotify-setup.js";
import { TelegramSetupOverlay } from "./tui/telegram-setup.js";
import { NtfySetupOverlay } from "./tui/ntfy-setup.js";
import { RecapModelSelectorOverlay } from "./tui/recap-model-selector.js";
import type { CachedModel } from "@pi-unipi/core";
import { loadConfig, saveConfig } from "./settings.js";
import { loadNtfyConfig } from "./ntfy-config.js";
import { sendNativeNotification, SuppressedError } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";

/**
 * Collect models for the recap selector from Pi's live model registry.
 * Returns undefined when the registry is unavailable so the overlay can fall
 * back to the project-wide model cache (issue #27: selector was empty because
 * it only read ~/.unipi/config/models-cache.json, which may not exist even
 * when models are configured in ~/.pi/agent/models.json).
 */
function registryModels(ctx: ExtensionContext): CachedModel[] | undefined {
  const registry = ctx.modelRegistry;
  if (!registry) return undefined;
  try {
    const models = registry.getAvailable?.() ?? registry.getAll() ?? [];
    return models.map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
  } catch {
    return undefined;
  }
}

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
          (tui, theme, _keybindings, done) => {
            const overlay = new NotifySettingsOverlay();
            overlay.setTheme(theme);
            overlay.onClose = () => done(undefined);
            overlay.requestRender = () => tui.requestRender();
            overlay.onOpenModelSelector = () => {
              // Open model selector as nested overlay
              ctx.ui.custom(
                (innerTui: any, innerTheme: any, _innerKb: any, innerDone: any) => {
                  const selector = new RecapModelSelectorOverlay(registryModels(ctx));
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

        const models = registryModels(ctx);
        ctx.ui.custom(
          (tui, theme, _keybindings, done) => {
            const overlay = new RecapModelSelectorOverlay(models);
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
          (tui, theme, _keybindings, done) => {
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
          (tui, theme, _keybindings, done) => {
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
          (tui, theme, _keybindings, done) => {
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

  // /unipi:notify-event <event> <on|off> — Non-TUI event toggle (issue #27 escape
  // hatch for terminals where overlay input is unusable)
  pi.registerCommand(
    `${UNIPI_PREFIX}${NOTIFY_COMMANDS.NOTIFY_EVENT}`,
    {
      description: "Toggle a notify event without the TUI: <event> <on|off>",
      handler: async (args: string, ctx: ExtensionContext) => {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const [event, value] = parts;

        if (parts.length !== 2 || (value !== "on" && value !== "off")) {
          ctx.ui.notify(
            "Usage: /unipi:notify-event <event> <on|off>",
            "warning"
          );
          return;
        }

        const config = loadConfig();
        if (!(event in config.events)) {
          const known = Object.keys(config.events).join(", ");
          ctx.ui.notify(
            `Unknown event "${event}". Known events: ${known}`,
            "error"
          );
          return;
        }

        config.events[event].enabled = value === "on";
        saveConfig(config);
        ctx.ui.notify(
          `notify: ${event} is now ${value}. Run /reload to re-register listeners.`,
          "info"
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
              suppressWhenFocused: config.native.suppressWhenFocused,
            });
            results.push("✓ Native: sent");
          } catch (err) {
            if (err instanceof SuppressedError) {
              results.push("— Native: suppressed (window focused)");
            } else {
              results.push(
                `✗ Native: ${err instanceof Error ? err.message : "failed"}`
              );
            }
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

        // ntfy — resolved from project/global ntfy.json
        const ntfyConfig = loadNtfyConfig(process.cwd());
        if (ntfyConfig.enabled && ntfyConfig.serverUrl && ntfyConfig.topic) {
          try {
            await sendNtfyNotification(
              ntfyConfig.serverUrl,
              ntfyConfig.topic,
              title,
              message,
              ntfyConfig.priority,
              ntfyConfig.token
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
