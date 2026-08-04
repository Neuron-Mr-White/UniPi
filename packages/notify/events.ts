/**
 * @pi-unipi/notify — Event subscription registry
 *
 * Maps pi lifecycle events to notification dispatch.
 * Supports built-in events and dynamic discovery via MODULE_READY.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import type { NotifyConfig, NotifyPlatform, NotifyDispatchResult } from "./types.js";
import { loadNtfyConfig } from "./ntfy-config.js";
import { sendNativeNotification, SuppressedError } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { sendNtfyNotification } from "./platforms/ntfy.js";
import { buildAskUserPromptMessage } from "./ask-user-prompt-message.js";
import { buildPermissionPromptMessage } from "./permission-prompt-message.js";
import { summarizeLastMessage } from "./summarize.js";

// Event emitted by @juicesharp/rpiv-ask-user-question before showing its UI.
// Keep this as a local string until that package publishes an importable
// `./events` contract in npm.
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;

// Event emitted by @gotgenes/pi-permission-system immediately before the
// user-facing permission UI is invoked. Fires only for prompts a human must
// answer — policy auto-allow/deny and session approvals do not emit it.
// Kept as a local string (like the rpiv event above) because it belongs to a
// third-party package rather than the unipi event contract.
const PERMISSION_UI_PROMPT_EVENT = "permissions:ui_prompt" as const;

/** Stored session context for modelRegistry access */
let sessionCtx: ExtensionContext | null = null;

/** Unsubscribe functions for pi.events.on() listeners. Cleared before each registration to avoid accumulation across reloads. */
const unsubs: Array<() => void> = [];

/** Unregister all previously registered pi.events.on() listeners. */
function unregisterAll(): void {
  for (const unsub of unsubs) {
    try { unsub(); } catch { /* ignore */ }
  }
  unsubs.length = 0;
}

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
  agent_end: { hook: "agent_end", label: "Agent Run Complete" },
  agent_settled: { hook: "agent_settled", label: "Agent Complete" },
  workflow_end: { hook: UNIPI_EVENTS.WORKFLOW_END, label: "Workflow Done" },
  ralph_loop_end: { hook: UNIPI_EVENTS.RALPH_LOOP_END, label: "Ralph Complete" },
  mcp_server_error: { hook: UNIPI_EVENTS.MCP_SERVER_ERROR, label: "MCP Error" },
  memory_consolidated: { hook: UNIPI_EVENTS.MEMORY_CONSOLIDATED, label: "Memory Saved" },
  session_shutdown: { hook: "session_shutdown", label: "Session End" },
  ask_user_prompt: { hook: UNIPI_EVENTS.ASK_USER_PROMPT, label: "Question Asked" },
  permission_request: { hook: PERMISSION_UI_PROMPT_EVENT, label: "Permission Request" },
};

/**
 * Pi lifecycle event types (dispatched by ExtensionRunner).
 * These must use pi.on() — not pi.events.on() — to receive events.
 */
const LIFECYCLE_EVENTS = new Set(["agent_end", "agent_settled", "session_shutdown"]);

/**
 * Register event listeners for all enabled notification events.
 * Attaches listeners to pi hooks and routes notifications to platforms.
 */
export function registerEventListeners(
  pi: ExtensionAPI,
  config: NotifyConfig,
  cwd: string
): void {
  // Remove all previously registered EventBus listeners to prevent accumulation
  // across reloads (EventBus persists but module instances are replaced).
  unregisterAll();
  // Register built-in events (except agent lifecycle notifications which have custom logic)
  for (const [eventKey, def] of Object.entries(BUILTIN_EVENTS)) {
    if (isAgentNotificationEvent(eventKey)) continue; // handled separately below

    const eventConfig = config.events[eventKey];
    if (!eventConfig?.enabled) continue;

    const handler = (payload: unknown) => {
      const title = `Pi — ${def.label}`;
      const message = buildEventMessage(eventKey, payload);
      // Fire-and-forget: don't block the event emitter
      dispatchNotification(pi, title, message, eventConfig.platforms, eventKey, config, cwd).catch(
        () => {
          // Silently ignore — background notification failure is non-blocking.
        }
      );
    };

    // Pi lifecycle events are dispatched via ExtensionRunner — must use
    // pi.on(). These are stored in
    // extension.handlers and automatically replaced on reload, so they
    // do NOT accumulate like EventBus listeners.
    if (LIFECYCLE_EVENTS.has(eventKey)) {
      (pi as any).on(def.hook, handler);
    } else {
      unsubs.push(pi.events.on(def.hook, handler));
    }
  }

  // Listen for rpiv:ask-user:prompt from @juicesharp/rpiv-ask-user-question
  const askUserConfig = config.events["ask_user_prompt"];
  if (askUserConfig?.enabled) {
    unsubs.push(pi.events.on(ASK_USER_PROMPT_EVENT, (payload: unknown) => {
      const title = `Pi — ${BUILTIN_EVENTS.ask_user_prompt.label}`;
      const message = buildAskUserPromptMessage(payload);
      dispatchNotification(pi, title, message, askUserConfig.platforms, "ask_user_prompt", config, cwd).catch(
        () => {
          // Silently ignore — background notification failure is non-blocking.
        }
      );
    }));
  }

  registerAgentNotification(pi, "agent_end", config, cwd);
  registerAgentNotification(pi, "agent_settled", config, cwd);

  // Listen for dynamic module events
  const moduleHandler = async (payload: unknown) => {
    const modPayload = payload as { name?: string; tools?: string[] };
    if (modPayload?.name && modPayload.name !== "@pi-unipi/notify") {
      // Module announced — check if it has events we should subscribe to
      // For now, modules register their own events through MODULE_READY
    }
  };
  unsubs.push(pi.events.on(UNIPI_EVENTS.MODULE_READY, moduleHandler));
}

/** Get all platforms that are currently enabled in config */
function getEnabledPlatforms(config: NotifyConfig, ntfyEnabled: boolean): NotifyPlatform[] {
  const enabled: NotifyPlatform[] = [];
  if (config.native.enabled) enabled.push("native");
  if (config.gotify.enabled) enabled.push("gotify");
  if (config.telegram.enabled) enabled.push("telegram");
  if (ntfyEnabled) enabled.push("ntfy");
  return enabled;
}

/** No-op — cleanup handled by session teardown */
export function unregisterEventListeners(): void {
  unregisterAll();
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
  config: NotifyConfig,
  cwd: string
): Promise<NotifyDispatchResult> {
  // Resolve ntfy config from project/global ntfy.json
  const ntfyConfig = loadNtfyConfig(cwd);

  // Resolve platforms: event-specific → all enabled → global defaults
  const platforms =
    eventPlatforms.length > 0
      ? eventPlatforms
      : getEnabledPlatforms(config, ntfyConfig.enabled).length > 0
        ? getEnabledPlatforms(config, ntfyConfig.enabled)
        : config.defaultPlatforms;

  const enabledPlatforms = platforms.filter((p) => {
    if (p === "native") return config.native.enabled;
    if (p === "gotify") return config.gotify.enabled;
    if (p === "telegram") return config.telegram.enabled;
    if (p === "ntfy") return ntfyConfig.enabled;
    return false;
  });

  const results = await Promise.all(
    enabledPlatforms.map(async (platform) => {
      try {
        await sendToPlatform(platform, title, message, config, cwd);
        return { platform, success: true };
      } catch (err) {
        // SuppressedError is intentional, not a failure
        if (err instanceof SuppressedError) {
          return { platform, success: true, suppressed: true };
        }
        // Silently ignore — platform send failure is tracked in results.
        return {
          platform,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  const unsuppressed = results.filter((r) => !r.suppressed);
  const allSuccess = results.length > 0 && unsuppressed.every((r) => r.success);
  const suppressedPlatforms = results
    .filter((r) => r.suppressed)
    .map((r) => r.platform);

  // Emit notification sent event
  emitEvent(pi, UNIPI_EVENTS.NOTIFICATION_SENT, {
    eventType,
    platforms: enabledPlatforms,
    success: allSuccess,
    ...(suppressedPlatforms.length > 0 && { suppressedPlatforms }),
    timestamp: new Date().toISOString(),
  });

  return { results, allSuccess };
}

/** Send to a single platform */
async function sendToPlatform(
  platform: NotifyPlatform,
  title: string,
  message: string,
  config: NotifyConfig,
  cwd: string
): Promise<void> {
  switch (platform) {
    case "native":
      await sendNativeNotification(title, message, {
        windowsAppId: config.native.windowsAppId,
        suppressWhenFocused: config.native.suppressWhenFocused,
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
    case "ntfy": {
      const ntfyConfig = loadNtfyConfig(cwd);
      if (!ntfyConfig.enabled) return;
      if (!ntfyConfig.serverUrl || !ntfyConfig.topic) {
        throw new Error("ntfy: serverUrl and topic are required");
      }
      await sendNtfyNotification(
        ntfyConfig.serverUrl,
        ntfyConfig.topic,
        title,
        message,
        ntfyConfig.priority,
        ntfyConfig.token
      );
      break;
    }
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
      return "Agent run finished responding";
    case "agent_settled":
      return "Agent is complete";
    case "memory_consolidated":
      return `Memory consolidated (${p.count || 0} items)`;
    case "session_shutdown":
      return "Session ending";
    case "ask_user_prompt":
      return buildAskUserPromptMessage(payload);
    case "permission_request":
      return buildPermissionPromptMessage(payload);
    default:
      return p.message ? String(p.message) : "Event occurred";
  }
}

/** Register an agent lifecycle notification with session name and recap support. */
function registerAgentNotification(
  pi: ExtensionAPI,
  eventKey: "agent_end" | "agent_settled",
  config: NotifyConfig,
  cwd: string
): void {
  const eventConfig = config.events[eventKey];
  if (!eventConfig?.enabled) return;

  const handler = (payload: unknown) => {
    // Fire-and-forget: build message and dispatch in background,
    // don't block agent lifecycle hooks from completing.
    const sessionName = pi.getSessionName?.();
    const title = `Pi — ${BUILTIN_EVENTS[eventKey].label}`;

    if (config.recap.enabled) {
      // Recap mode: summarize asynchronously, then dispatch.
      // agent_settled does not currently include a messages payload, so fall
      // back to the latest assistant message in the session.
      const lastText = extractLastAssistantText(payload) ?? extractLastAssistantTextFromSession();
      if (lastText && sessionCtx?.modelRegistry) {
        const provider = extractProvider(config.recap.model);
        const modelId = extractModelId(config.recap.model);
        const model = sessionCtx.modelRegistry.find(provider, modelId);
        if (model) {
          sessionCtx.modelRegistry.getApiKeyAndHeaders(model)
            .then((apiKeyResult) => {
              const apiKey = apiKeyResult.ok ? (apiKeyResult as { apiKey?: string }).apiKey : undefined;
              if (apiKey) {
                return summarizeLastMessage(lastText, apiKey, model.baseUrl, model.api, modelId)
                  .then((recap) => sessionName ? `${sessionName}: ${recap}` : recap);
              }
              return buildAgentLifecycleMessage(eventKey, sessionName);
            })
            .catch(() => buildAgentLifecycleMessage(eventKey, sessionName))
            .then((message) =>
              dispatchNotification(pi, title, message, eventConfig.platforms, eventKey, config, cwd)
            )
            .catch(() => {
              // Silently ignore — background agent notification failure is non-blocking.
            });
          return;
        }
      }
    }

    // No recap or recap unavailable: dispatch immediately in background.
    const message = buildAgentLifecycleMessage(eventKey, sessionName);
    dispatchNotification(pi, title, message, eventConfig.platforms, eventKey, config, cwd).catch(
      () => {
        // Silently ignore — background agent notification failure is non-blocking.
      }
    );
  };

  (pi as any).on(eventKey, handler);
}

/** Whether an event key is an agent lifecycle notification with custom handling. */
function isAgentNotificationEvent(eventKey: string): eventKey is "agent_end" | "agent_settled" {
  return eventKey === "agent_end" || eventKey === "agent_settled";
}

/** Build agent lifecycle message using session name. */
function buildAgentLifecycleMessage(
  eventKey: "agent_end" | "agent_settled",
  sessionName: string | undefined
): string {
  const status = eventKey === "agent_end" ? "Agent run is complete" : "Agent is complete";
  if (sessionName) return `${sessionName} - ${status}`;
  return status;
}

/** Extract text from the latest assistant message in the current session. */
function extractLastAssistantTextFromSession(): string | null {
  const entries = sessionCtx?.sessionManager.getEntries() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const text = extractAssistantText(entry.message);
    if (text) return text;
  }
  return null;
}

/** Extract text from the last assistant message in an agent lifecycle payload. */
function extractLastAssistantText(payload: unknown): string | null {
  const p = payload as { messages?: Array<{ role?: string; content?: unknown }> };
  if (!p?.messages || !Array.isArray(p.messages)) return null;

  // Find last assistant message
  for (let i = p.messages.length - 1; i >= 0; i--) {
    const msg = p.messages[i];
    if (msg?.role !== "assistant") continue;

    const text = extractAssistantText(msg);
    if (text) return text;
  }

  return null;
}

/** Extract text from an assistant message-like object. */
function extractAssistantText(message: { role?: string; content?: unknown }): string | null {
  if (message.role !== "assistant") return null;

  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Extract text blocks from content array.
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
