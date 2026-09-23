/**
 * @pi-unipi/notify — Command registration
 *
 * Registers slash commands for notification configuration and testing.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";
import { HUB_OVERLAY_OPTIONS, NOTIFY_COMMANDS, registerCommandRunner } from "@pi-unipi/core";
import { GotifySetupOverlay } from "./tui/gotify-setup.js";
import { TelegramSetupOverlay } from "./tui/telegram-setup.js";
import { NtfySetupOverlay } from "./tui/ntfy-setup.js";
import { loadConfig, saveConfig } from "./settings.js";
import { loadNtfyConfig } from "./ntfy-config.js";
import { sendNativeNotification, SuppressedError } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";

/**
 * Register notify commands.
 */
export function registerNotifyCommands(pi: ExtensionAPI): void {
  // Shared setup-wizard invoker — also registered as a hub action runner so
  // the platform pages in /unipi:settings can open the same wizards.
  const gotifySetupHandler = async (rawCtx: unknown) => {
    const ctx = rawCtx as ExtensionContext;
    if (!ctx.hasUI) {
      ctx.ui.notify("Gotify setup requires an interactive UI.", "warning");
      return;
    }
    await ctx.ui.custom(
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
        ...HUB_OVERLAY_OPTIONS,
      }
    );
  };
  registerCommandRunner(NOTIFY_COMMANDS.SET_GOTIFY, gotifySetupHandler);


  const telegramSetupHandler = async (rawCtx: unknown) => {
    const ctx = rawCtx as ExtensionContext;
    if (!ctx.hasUI) {
      ctx.ui.notify("Telegram setup requires an interactive UI.", "warning");
      return;
    }
    await ctx.ui.custom(
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
        ...HUB_OVERLAY_OPTIONS,
      }
    );
  };
  registerCommandRunner(NOTIFY_COMMANDS.SET_TG, telegramSetupHandler);


  const ntfySetupHandler = async (rawCtx: unknown) => {
    const ctx = rawCtx as ExtensionContext;
    if (!ctx.hasUI) {
      ctx.ui.notify("ntfy setup requires an interactive UI.", "warning");
      return;
    }
    await ctx.ui.custom(
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
        ...HUB_OVERLAY_OPTIONS,
      }
    );
  };
  registerCommandRunner(NOTIFY_COMMANDS.SET_NTFY, ntfySetupHandler);


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

  // notify-test handler — shared with the hub "Send test notification" action.
  const notifyTestHandler = async (rawCtx: unknown) => {
    const ctx = rawCtx as ExtensionContext;
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
      ctx.ui.notify("No platforms enabled. Enable one in /unipi:settings (Notify).", "warning");
    } else {
      ctx.ui.notify(`Test results:\n${results.join("\n")}`, "info");
    }
  };
  registerCommandRunner(NOTIFY_COMMANDS.TEST, notifyTestHandler);

}
