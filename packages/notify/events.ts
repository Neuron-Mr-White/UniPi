/**
 * @pi-unipi/notify — Event subscription registry
 *
 * Maps pi lifecycle events to notification dispatch.
 * Supports built-in events and dynamic discovery via MODULE_READY.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import type { NotifyConfig, NotifyPlatform, NotifyDispatchResult } from "./types.js";
import { sendNativeNotification } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { loadConfig } from "./settings.js";

/** Built-in event definitions — maps event key to pi hook + display label */
export const BUILTIN_EVENTS: Record<
  string,
  { hook: string; label: string }
> = {
  agent_end: { hook: "agent_end", label: "Agent Complete" },
  workflow_end: { hook: UNIPI_EVENTS.WORKFLOW_END, label: "Workflow Done" },
  ralph_loop_end: { hook: UNIPI_EVENTS.RALPH_LOOP_END, label: "Ralph Complete" },
  mcp_server_error: { hook: UNIPI_EVENTS.MCP_SERVER_ERROR, label: "MCP Error" },
  memory_consolidated: { hook: UNIPI_EVENTS.MEMORY_CONSOLIDATED, label: "Memory Saved" },
  session_shutdown: { hook: "session_shutdown", label: "Session End" },
};

/** Stores registered listener cleanup functions */
const cleanupFns: Array<() => void> = [];

/**
 * Register event listeners for all enabled notification events.
 * Attaches listeners to pi hooks and routes notifications to platforms.
 */
export function registerEventListeners(
  pi: ExtensionAPI,
  config: NotifyConfig
): void {
  // Register built-in events
  for (const [eventKey, def] of Object.entries(BUILTIN_EVENTS)) {
    const eventConfig = config.events[eventKey];
    if (!eventConfig?.enabled) continue;

    const handler = async (payload: unknown) => {
      const title = `Pi — ${def.label}`;
      const message = buildEventMessage(eventKey, payload);
      await dispatchNotification(pi, title, message, eventConfig.platforms, eventKey, config);
    };

    (pi as any).on(def.hook, handler);
    cleanupFns.push(() => {
      (pi as any).off(def.hook, handler);
    });
  }

  // Listen for dynamic module events
  const moduleHandler = async (payload: unknown) => {
    const modPayload = payload as { name?: string; tools?: string[] };
    if (modPayload?.name && modPayload.name !== "@pi-unipi/notify") {
      // Module announced — check if it has events we should subscribe to
      // For now, modules register their own events through MODULE_READY
    }
  };
  (pi as any).on(UNIPI_EVENTS.MODULE_READY, moduleHandler);
  cleanupFns.push(() => {
    (pi as any).off(UNIPI_EVENTS.MODULE_READY, moduleHandler);
  });
}

/** Remove all registered event listeners */
export function unregisterEventListeners(): void {
  for (const cleanup of cleanupFns) {
    cleanup();
  }
  cleanupFns.length = 0;
}

/**
 * Dispatch a notification to the configured platforms.
 * Sends to all specified platforms (or defaults) in parallel.
 */
export async function dispatchNotification(
  pi: ExtensionAPI,
  title: string,
  message: string,
  eventPlatforms: NotifyPlatform[],
  eventType: string,
  config: NotifyConfig
): Promise<NotifyDispatchResult> {
  const platforms =
    eventPlatforms.length > 0 ? eventPlatforms : config.defaultPlatforms;

  const enabledPlatforms = platforms.filter((p) => {
    if (p === "native") return config.native.enabled;
    if (p === "gotify") return config.gotify.enabled;
    if (p === "telegram") return config.telegram.enabled;
    return false;
  });

  const results = await Promise.all(
    enabledPlatforms.map(async (platform) => {
      try {
        await sendToPlatform(platform, title, message, config);
        return { platform, success: true };
      } catch (err) {
        console.error(
          `[notify] Failed to send via ${platform}:`,
          err instanceof Error ? err.message : err
        );
        return {
          platform,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const allSuccess = results.length > 0 && results.every((r) => r.success);

  // Emit notification sent event
  emitEvent(pi, UNIPI_EVENTS.NOTIFICATION_SENT, {
    eventType,
    platforms: enabledPlatforms,
    success: allSuccess,
    timestamp: new Date().toISOString(),
  });

  return { results, allSuccess };
}

/** Send to a single platform */
async function sendToPlatform(
  platform: NotifyPlatform,
  title: string,
  message: string,
  config: NotifyConfig
): Promise<void> {
  switch (platform) {
    case "native":
      await sendNativeNotification(title, message, {
        windowsAppId: config.native.windowsAppId,
      });
      break;
    case "gotify":
      if (!config.gotify.serverUrl || !config.gotify.appToken) {
        throw new Error("Gotify: serverUrl and appToken are required");
      }
      await sendGotifyNotification(
        config.gotify.serverUrl,
        config.gotify.appToken,
        title,
        message,
        config.gotify.priority
      );
      break;
    case "telegram":
      if (!config.telegram.botToken || !config.telegram.chatId) {
        throw new Error("Telegram: botToken and chatId are required");
      }
      await sendTelegramNotification(
        config.telegram.botToken,
        config.telegram.chatId,
        title,
        message
      );
      break;
  }
}

/** Build notification message from event key and payload */
function buildEventMessage(eventKey: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;

  switch (eventKey) {
    case "workflow_end":
      return `Workflow ${String(p.command || "unknown")}${p.success === false ? " failed" : " completed"}`;
    case "ralph_loop_end":
      return `Ralph loop "${String(p.name || "unknown")}" ${p.status || "completed"}`;
    case "mcp_server_error":
      return `Server "${String(p.name || "unknown")}" error: ${String(p.error || "unknown error")}`;
    case "agent_end":
      return "Agent finished responding";
    case "memory_consolidated":
      return `Memory consolidated (${p.count || 0} items)`;
    case "session_shutdown":
      return "Session ending";
    default:
      return p.message ? String(p.message) : "Event occurred";
  }
}
