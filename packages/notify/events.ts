/**
 * @pi-unipi/notify — Event subscription registry
 *
 * Maps pi lifecycle events to notification dispatch.
 * Supports built-in events and dynamic discovery via MODULE_READY.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import type { NotifyConfig, NotifyPlatform, NotifyDispatchResult } from "./types.js";
import { sendNativeNotification } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";
import { summarizeLastMessage } from "./summarize.js";

/** Stored session context for modelRegistry access */
let sessionCtx: ExtensionContext | null = null;

/** Store session context (called from index.ts on session_start) */
export function setSessionContext(ctx: ExtensionContext): void {
  sessionCtx = ctx;
}

/** Clear session context (called on session_shutdown) */
export function clearSessionContext(): void {
  sessionCtx = null;
}

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
  ask_user_prompt: { hook: UNIPI_EVENTS.ASK_USER_PROMPT, label: "Question Asked" },
};

/**
 * Register event listeners for all enabled notification events.
 * Attaches listeners to pi hooks and routes notifications to platforms.
 */
export function registerEventListeners(
  pi: ExtensionAPI,
  config: NotifyConfig
): void {
  // Register built-in events (except agent_end which has custom logic)
  for (const [eventKey, def] of Object.entries(BUILTIN_EVENTS)) {
    if (eventKey === "agent_end") continue; // handled separately below

    const eventConfig = config.events[eventKey];
    if (!eventConfig?.enabled) continue;

    const handler = async (payload: unknown) => {
      const title = `Pi — ${def.label}`;
      const message = buildEventMessage(eventKey, payload);
      await dispatchNotification(pi, title, message, eventConfig.platforms, eventKey, config);
    };

    (pi as any).on(def.hook, handler);
  }

  // agent_end — custom handler with session name and recap support
  const agentEndConfig = config.events["agent_end"];
  if (agentEndConfig?.enabled) {
    const handler = async (payload: unknown) => {
      const sessionName = pi.getSessionName?.();
      const title = `Pi — ${BUILTIN_EVENTS.agent_end.label}`;
      let message: string;

      if (config.recap.enabled) {
        // Recap mode: summarize last assistant message
        const lastText = extractLastAssistantText(payload);
        if (lastText && sessionCtx?.modelRegistry) {
          const provider = extractProvider(config.recap.model);
          const modelId = extractModelId(config.recap.model);
          const model = sessionCtx.modelRegistry.find(provider, modelId);
          if (model) {
            try {
              const apiKeyResult = await sessionCtx.modelRegistry.getApiKeyAndHeaders(model);
              const apiKey = apiKeyResult.ok ? (apiKeyResult as { apiKey?: string }).apiKey : undefined;
              if (apiKey) {
                const recap = await summarizeLastMessage(lastText, apiKey, model.baseUrl, model.api, modelId);
                message = sessionName ? `${sessionName}: ${recap}` : recap;
              } else {
                message = buildAgentEndMessage(sessionName);
              }
            } catch {
              message = buildAgentEndMessage(sessionName);
            }
          } else {
            message = buildAgentEndMessage(sessionName);
          }
        } else {
          message = buildAgentEndMessage(sessionName);
        }
      } else {
        // No recap: use session name based message
        message = buildAgentEndMessage(sessionName);
      }

      await dispatchNotification(pi, title, message, agentEndConfig.platforms, "agent_end", config);
    };

    (pi as any).on("agent_end", handler);
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
}

/** Get all platforms that are currently enabled in config */
function getEnabledPlatforms(config: NotifyConfig): NotifyPlatform[] {
  const enabled: NotifyPlatform[] = [];
  if (config.native.enabled) enabled.push("native");
  if (config.gotify.enabled) enabled.push("gotify");
  if (config.telegram.enabled) enabled.push("telegram");
  if (config.ntfy.enabled) enabled.push("ntfy");
  return enabled;
}

/** No-op — cleanup handled by session teardown */
export function unregisterEventListeners(): void {}

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
  // Resolve platforms: event-specific → all enabled → global defaults
  const platforms =
    eventPlatforms.length > 0
      ? eventPlatforms
      : getEnabledPlatforms(config).length > 0
        ? getEnabledPlatforms(config)
        : config.defaultPlatforms;

  const enabledPlatforms = platforms.filter((p) => {
    if (p === "native") return config.native.enabled;
    if (p === "gotify") return config.gotify.enabled;
    if (p === "telegram") return config.telegram.enabled;
    if (p === "ntfy") return config.ntfy.enabled;
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
    case "ntfy":
      if (!config.ntfy.serverUrl || !config.ntfy.topic) {
        throw new Error("ntfy: serverUrl and topic are required");
      }
      await sendNtfyNotification(
        config.ntfy.serverUrl,
        config.ntfy.topic,
        title,
        message,
        config.ntfy.priority,
        config.ntfy.token
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
    case "ask_user_prompt":
      return p.context
        ? `Agent asks: ${String(p.question || "")} — ${String(p.context)}`
        : `Agent asks: ${String(p.question || "A question")}`;
    default:
      return p.message ? String(p.message) : "Event occurred";
  }
}

/** Build agent_end message using session name */
function buildAgentEndMessage(sessionName: string | undefined): string {
  if (sessionName) return `${sessionName} - Agent is complete`;
  return "Agent is complete";
}

/** Extract text from the last assistant message in agent_end payload */
function extractLastAssistantText(payload: unknown): string | null {
  const p = payload as { messages?: Array<{ role?: string; content?: unknown }> };
  if (!p?.messages || !Array.isArray(p.messages)) return null;

  // Find last assistant message
  for (let i = p.messages.length - 1; i >= 0; i--) {
    const msg = p.messages[i];
    if (msg?.role !== "assistant") continue;

    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      // Extract text blocks from content array
      const textParts: string[] = [];
      for (const block of content) {
        if (typeof block === "object" && block !== null) {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") {
            textParts.push(b.text);
          }
        }
      }
      if (textParts.length > 0) return textParts.join("\n");
    }
  }

  return null;
}

/** Extract provider from model reference (e.g. "openrouter/openai/gpt-oss-20b" → "openrouter") */
function extractProvider(modelRef: string): string {
  const slashIdx = modelRef.indexOf("/");
  return slashIdx > 0 ? modelRef.slice(0, slashIdx) : modelRef;
}

/** Extract model ID from full reference (e.g. "openrouter/openai/gpt-oss-20b" → "openai/gpt-oss-20b") */
function extractModelId(modelRef: string): string {
  const slashIdx = modelRef.indexOf("/");
  return slashIdx > 0 ? modelRef.slice(slashIdx + 1) : modelRef;
}

/** Resolve API key for a provider from environment variables */
function resolveApiKey(modelRef: string): string | undefined {
  const provider = extractProvider(modelRef);
  // Try standard env var patterns
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return process.env[envKey];
}
