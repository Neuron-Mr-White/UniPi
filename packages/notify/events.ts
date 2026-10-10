/**
 * @pi-unipi/notify — Event subscription registry
 *
 * Maps pi lifecycle events to notification dispatch.
 * Supports built-in events and dynamic discovery via MODULE_READY.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bus, hasPendingWork, isUnipiEventName, subscribeWorkChanges, UNIPI_EVENTS } from "@pi-unipi/core";
import type { NotifyConfig, NotifyPlatform, NotifyDispatchResult, NotifyPriority } from "./types.js";
import { loadNtfyConfig } from "./ntfy-config.js";
import { sendNativeNotification, SuppressedError } from "./platforms/native.js";
import { sendGotifyNotification } from "./platforms/gotify.js";
import { sendTelegramNotification } from "./platforms/telegram.js";
import { sendNtfyNotification, publishToEndpoint } from "./platforms/ntfy.js";
import { loadAppEndpoints } from "./app-endpoints.js";
import { loadNotifyKey } from "./notify-key.js";
import { hostname } from "node:os";
import { buildAskUserPromptMessage } from "./ask-user-prompt-message.js";
import { buildPermissionPromptMessage } from "./permission-prompt-message.js";
import { buildInputNeededMessage } from "./input-needed-message.js";
import { summarizeLastMessage } from "./summarize.js";
import { filterPlatformsAfterInput, isBlockingEvent } from "./activity.js";

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

/** Minimal shape of the background-tasks shared registry (optional sibling package). */
type SharedTaskRegistryLike = {
  allTasks(): ReadonlyArray<{ status?: string; triggerOnCompletion?: boolean }>;
};

/** Symbol @pi-unipi/background-tasks publishes its live registry under. */
const SHARED_REGISTRY_KEY = Symbol.for("unipi.background-tasks.shared-registry");

/**
 * True when a background task will wake the agent with its own follow-up turn.
 * Reads the shared globalThis symbol directly rather than importing
 * @pi-unipi/background-tasks, so notify has zero load-order or dependency
 * coupling to that optional sibling. Any read failure means "no pending wake".
 */
export function hasPendingWakeTask(): boolean {
  try {
    const registry = (globalThis as Record<symbol, unknown>)[SHARED_REGISTRY_KEY] as
      | SharedTaskRegistryLike
      | undefined;
    if (typeof registry?.allTasks !== "function") return false;
    const tasks = registry.allTasks();
    return Array.isArray(tasks)
      ? tasks.some((task) => task.status === "running" && task.triggerOnCompletion === true)
      : false;
  } catch {
    return false;
  }
}

/** Default dispatch priority for an event type, when the event path sets one. */
function defaultEventPriority(eventKey: string): NotifyPriority | undefined {
  if (isBlockingEvent(eventKey)) return "high";
  if (isAgentNotificationEvent(eventKey)) return "low";
  return undefined;
}

/** Stored session context for modelRegistry access */
let sessionCtx: ExtensionContext | null = null;

/** Unsubscribe functions for pi.events.on() listeners. Cleared before each registration to avoid accumulation across reloads. */
const unsubs: Array<() => void> = [];

/** Pending re-notify interval for an unanswered blocking prompt. */
let renotifyTimer: ReturnType<typeof setInterval> | undefined;

/**
 * UNI-162: true once an agent_end/agent_settled "done" notification was
 * suppressed because `hasPendingWakeTask()` or core's `hasPendingWork()`
 * (subagents still running, fusion handoffs in flight) said work was still
 * pending. Watched by the work-change subscriber below so the eventual
 * all-clear sends exactly ONE "All done" notification instead of pi's idle
 * state silently going unnotified.
 */
let pendingWorkSuppressedDone = false;
/** Unsubscribe from the shared work-list change signal (torn down on reload). */
let unsubPendingWorkWatch: (() => void) | undefined;
/** Grace timer between "pending work cleared" and the "All done" send. */
let allDoneTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * UNI-221: how long after pending work clears the watcher waits for the
 * wake turn to start before it sends "All done". Exported for tests.
 */
export const ALL_DONE_GRACE_MS = 2500;

/**
 * A `ui_prompt_start` within this window of an ask_user/permission alert is
 * the same prompt — pi emits the bus event and the lifecycle event back to
 * back. Exported for tests.
 */
export const PROMPT_DEDUP_MS = 2000;

/** Whether an agent run is in progress — `input_needed` fires only while it is. */
let agentRunning = false;

/** Open blocking UI prompts (`ui_prompt_start`/`ui_prompt_end` pairing). */
let openPrompts = 0;

/** When the last ask_user/permission alert went out, for ui_prompt de-dup. */
let lastBlockingAlertAt = 0;

/** Cancel any pending re-notify timer. Safe to call at any time. */
export function disarmRenotify(): void {
  const timer = renotifyTimer;
  renotifyTimer = undefined;
  if (timer === undefined) return;
  try {
    clearInterval(timer);
  } catch {
    // Timer already gone (e.g. after a reload) — nothing to clear.
  }
}

/**
 * (Re)arm the reminder loop for a blocking prompt. Only one prompt can be
 * outstanding at a time, so arming replaces any existing timer rather than
 * stacking a second one.
 */
function armRenotify(
  pi: ExtensionAPI,
  title: string,
  message: string,
  platforms: NotifyPlatform[],
  eventType: string,
  config: NotifyConfig,
  cwd: string,
  dispatch: DispatchNotification,
): void {
  disarmRenotify();
  const { enabled, intervalMs, maxRepeats } = config.renotify;
  if (!enabled || maxRepeats <= 0) return;

  let fired = 0;
  const timer = setInterval(() => {
    fired += 1;
    dispatch(
      pi,
      `${title} (still waiting)`,
      message,
      platforms,
      eventType,
      config,
      cwd,
      "high"
    ).catch(() => {
      // Silently ignore — background notification failure is non-blocking.
    });
    if (fired >= maxRepeats) disarmRenotify();
  }, intervalMs);
  // Never hold the process open for a reminder. (undefined-safe for mocked timers.)
  timer.unref?.();
  renotifyTimer = timer;
}

/**
 * Dispatch a human-blocking prompt alert: high priority plus the reminder
 * loop. Non-`input_needed` alerts also stamp `lastBlockingAlertAt` so the
 * back-to-back `ui_prompt_start` for the same prompt is seen as announced.
 */
function notifyBlocking(
  pi: ExtensionAPI,
  eventKey: string,
  title: string,
  message: string,
  platforms: NotifyPlatform[],
  config: NotifyConfig,
  cwd: string,
  dispatch: DispatchNotification,
): void {
  if (eventKey !== "input_needed") lastBlockingAlertAt = Date.now();
  dispatch(pi, title, message, platforms, eventKey, config, cwd, "high").catch(() => {
    // Silently ignore — background notification failure is non-blocking.
  });
  armRenotify(pi, title, message, platforms, eventKey, config, cwd, dispatch);
}

/** Unregister all previously registered pi.events.on() listeners. */
function unregisterAll(): void {
  disarmRenotify();
  agentRunning = false;
  openPrompts = 0;
  disarmAllDoneWatch();
  cancelFinish();
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
  ralph_loop_end: { hook: UNIPI_EVENTS.RALPH_LOOP_END, label: "Ralph Complete" },
  mcp_server_error: { hook: UNIPI_EVENTS.MCP_SERVER_ERROR, label: "MCP Error" },
  session_shutdown: { hook: "session_shutdown", label: "Session End" },
  ask_user_prompt: { hook: UNIPI_EVENTS.ASK_USER_PROMPT, label: "Question Asked" },
  permission_request: { hook: PERMISSION_UI_PROMPT_EVENT, label: "Permission Request" },
  input_needed: { hook: "ui_prompt_start", label: "Input Needed" },
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
  cwd: string,
  dispatch: DispatchNotification = dispatchNotification
): void {
  // Remove all previously registered EventBus listeners to prevent accumulation
  // across reloads (EventBus persists but module instances are replaced).
  unregisterAll();
  // Register built-in events (except agent lifecycle notifications which have custom logic)
  for (const [eventKey, def] of Object.entries(BUILTIN_EVENTS)) {
    // Agent notifications have custom logic; input_needed has its own
    // ui_prompt_start registration below (with agent-running + de-dup guards).
    if (isAgentNotificationEvent(eventKey) || eventKey === "input_needed") continue;

    const eventConfig = config.events[eventKey];
    if (!eventConfig?.enabled) continue;

    const handler = (payload: unknown) => {
      const title = `Pi — ${def.label}`;
      const message = buildEventMessage(eventKey, payload);
      // Human-blocking prompts: high priority, reminder loop, and a stamp
      // that keeps the follow-up ui_prompt_start from double-firing.
      if (isBlockingEvent(eventKey)) {
        notifyBlocking(pi, eventKey, title, message, eventConfig.platforms, config, cwd, dispatch);
        return;
      }
      // Fire-and-forget: don't block the event emitter
      dispatch(
        pi,
        title,
        message,
        eventConfig.platforms,
        eventKey,
        config,
        cwd,
        defaultEventPriority(eventKey)
      ).catch(() => {
        // Silently ignore — background notification failure is non-blocking.
      });
    };

    // Pi lifecycle events are dispatched via ExtensionRunner — must use
    // pi.on(). These are stored in
    // extension.handlers and automatically replaced on reload, so they
    // do NOT accumulate like EventBus listeners.
    const hook = def.hook;
    if (LIFECYCLE_EVENTS.has(eventKey)) {
      (pi as any).on(hook, handler);
    } else if (isUnipiEventName(hook)) {
      // Internal unipi events ride the central bus.
      unsubs.push(bus.on(pi, hook, handler));
    } else {
      unsubs.push(pi.events.on(hook, handler));
    }
  }

  // Listen for rpiv:ask-user:prompt from @juicesharp/rpiv-ask-user-question
  const askUserConfig = config.events["ask_user_prompt"];
  if (askUserConfig?.enabled) {
    unsubs.push(pi.events.on(ASK_USER_PROMPT_EVENT, (payload: unknown) => {
      notifyBlocking(
        pi,
        "ask_user_prompt",
        `Pi — ${BUILTIN_EVENTS.ask_user_prompt.label}`,
        buildAskUserPromptMessage(payload),
        askUserConfig.platforms,
        config,
        cwd,
        dispatch,
      );
    }));
  }

  // A reminder loop must never outlive the prompt it is nagging about: any of
  // these signals means the human acted or the agent moved on.
  unsubs.push(pi.events.on("herdr:blocked", (payload: unknown) => {
    if ((payload as { active?: unknown } | null)?.active === false) disarmRenotify();
  }));
  (pi as any).on("agent_start", () => {
    agentRunning = true;
    disarmRenotify();
    // UNI-221: a turn starting (often the wake from the pending work) owns
    // the "finished" notification now — never also send "All done".
    disarmAllDoneWatch();
  });

  // UNI-223: ONE "finished" notification per run, whichever of agent_end /
  // agent_settled is switched on (both mean "the run finished" to a user).
  registerRunFinishedNotification(pi, config, cwd, dispatch);

  // Keep the agent-running flag in sync. Registered after the agent
  // notification handlers above so the first agent_end handler stays the
  // notification path (pi.on handlers fire in registration order).
  (pi as any).on("agent_end", () => {
    agentRunning = false;
  });

  registerInputNeeded(pi, config, cwd, dispatch);
}

/**
 * pi ≥0.84.4 fires `ui_prompt_start`/`ui_prompt_end` around every blocking
 * user-facing prompt — including ones that emit no bus event of their own
 * (third-party ask_user tools, the permission prompt, the plan review).
 *
 * The start/end pair is registered whenever we are not a subagent child,
 * independent of the `input_needed` flag: the open-prompt counter must stay
 * paired so a prompt closing also disarms ask_user/permission reminders.
 * Only the notification itself respects the flag, and it fires only while
 * the agent is running — a `ui_prompt_start` while idle is the user's own
 * overlay (e.g. /unipi:settings).
 */
function registerInputNeeded(
  pi: ExtensionAPI,
  config: NotifyConfig,
  cwd: string,
  dispatch: DispatchNotification,
): void {
  // Subagent children never own a user-facing prompt.
  if (process.env.UNIPI_SUBAGENT_CHILD === "1") return;

  (pi as any).on("ui_prompt_start", (payload: unknown) => {
    openPrompts += 1;
    const eventConfig = config.events["input_needed"];
    if (!eventConfig?.enabled) return;
    if (!agentRunning) return;
    // Same prompt already announced as ask_user/permission_request.
    if (Date.now() - lastBlockingAlertAt < PROMPT_DEDUP_MS) return;
    notifyBlocking(
      pi,
      "input_needed",
      `Pi — ${BUILTIN_EVENTS.input_needed.label}`,
      buildInputNeededMessage(payload),
      eventConfig.platforms,
      config,
      cwd,
      dispatch,
    );
  });

  (pi as any).on("ui_prompt_end", () => {
    openPrompts = Math.max(0, openPrompts - 1);
    if (openPrompts === 0) disarmRenotify();
  });
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

/** Dispatcher signature — injectable so tests can observe calls without sending. */
export type DispatchNotification = typeof dispatchNotification;

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
  cwd: string,
  priority?: NotifyPriority,
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

  const { send: platformsToSend, silenced: inputSilenced } =
    filterPlatformsAfterInput(enabledPlatforms, config, Date.now(), eventType);

  const results = await Promise.all(
    platformsToSend.map(async (platform) => {
      try {
        const effectivePriority = await sendToPlatform(platform, title, message, config, cwd, priority, eventType);
        return { platform, success: true, ...(effectivePriority === undefined ? {} : { priority: effectivePriority }) };
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

  for (const platform of inputSilenced) {
    results.push({ platform, success: true, suppressed: true });
  }

  const unsuppressed = results.filter((r) => !r.suppressed);
  const allSuccess = results.length > 0 && unsuppressed.every((r) => r.success);
  const suppressedPlatforms = results
    .filter((r) => r.suppressed)
    .map((r) => r.platform);

  // Emit notification sent event
  bus.emit(UNIPI_EVENTS.NOTIFICATION_SENT, {
    eventType,
    platforms: enabledPlatforms,
    success: allSuccess,
    ...(suppressedPlatforms.length > 0 && { suppressedPlatforms }),
    timestamp: new Date().toISOString(),
  });

  return { results, allSuccess };
}

/** Send to a single platform */
export function mapNotifyPriority(platform: "gotify" | "ntfy", priority: NotifyPriority): number {
  const mappings = {
    gotify: { low: 2, normal: 5, high: 8 },
    ntfy: { low: 2, normal: 3, high: 5 },
  } as const;
  return mappings[platform][priority];
}

async function sendToPlatform(
  platform: NotifyPlatform,
  title: string,
  message: string,
  config: NotifyConfig,
  cwd: string,
  priority?: NotifyPriority,
  eventType?: string,
): Promise<number | undefined> {
  switch (platform) {
    case "native":
      await sendNativeNotification(title, message, {
        windowsAppId: config.native.windowsAppId,
        suppressWhenFocused: config.native.suppressWhenFocused,
      });
      return undefined;
    case "gotify":
      if (!config.gotify.serverUrl || !config.gotify.appToken) {
        throw new Error("Gotify: serverUrl and appToken are required");
      }
      await sendGotifyNotification(
        config.gotify.serverUrl,
        config.gotify.appToken,
        title,
        message,
        priority ? mapNotifyPriority("gotify", priority) : config.gotify.priority
      );
      return priority ? mapNotifyPriority("gotify", priority) : config.gotify.priority;
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
      return undefined;
    case "ntfy": {
      const ntfyConfig = loadNtfyConfig(cwd);
      if (!ntfyConfig.enabled) return undefined;
      if (!ntfyConfig.serverUrl || !ntfyConfig.topic) {
        throw new Error("ntfy: serverUrl and topic are required");
      }
      const effective = priority ? mapNotifyPriority("ntfy", priority) : ntfyConfig.priority;
      // UNI-161 §4: app routing data (deep link + tag) lets the phone jump
      // straight to the right chat; `host` is the machine hostname (the pi
      // side has no paired-host id of its own — the app maps hostname →
      // paired host). appDetail controls whether the prompt text itself
      // rides along or just a generic "tap to open" message.
      const route = { host: hostnameForRoute(), kind: eventType };
      const options = { route, appDetail: ntfyConfig.appDetail ?? "minimal", encryptKey: loadNotifyKey() };
      await sendNtfyNotification(ntfyConfig.serverUrl, ntfyConfig.topic, title, message, effective, ntfyConfig.token, options);
      // Fan out to every phone that registered a UnifiedPush endpoint
      // (notify_register) — best-effort, never blocks/fails the primary send.
      const endpoints = loadAppEndpoints();
      if (endpoints.length) {
        await Promise.all(
          endpoints.map((e) =>
            publishToEndpoint(e.url, title, message, effective, options).catch(() => {
              // one dead/revoked endpoint must never fail the whole dispatch
            }),
          ),
        );
      }
      return effective;
    }
  }
}

/** Best-effort machine hostname for the ntfy deep link's `host` param (the
 * pi process has no paired-host id of its own — see platforms/ntfy.ts). */
function hostnameForRoute(): string {
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

/** Build notification message from event key and payload */
function buildEventMessage(eventKey: string, payload: unknown): string {
  const p = payload as Record<string, unknown>;

  switch (eventKey) {
    case "ralph_loop_end":
      return `Ralph loop "${String(p.name || "unknown")}" ${p.status || "completed"}`;
    case "mcp_server_error":
      return `Server "${String(p.name || "unknown")}" error: ${String(p.error || "unknown error")}`;
    case "agent_end":
      return "Agent run finished responding";
    case "agent_settled":
      return "Agent is complete";
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

/**
 * Arm the "All done" watcher once (idempotent per registration): subscribes
 * to the shared work-list change signal and, the first time every wait
 * source clears AND pi reports idle, sends exactly one "All done"
 * notification. Nothing re-arms until the next suppressed agent_end/
 * agent_settled (set by the caller before calling this).
 */
function armAllDoneWatch(
  pi: ExtensionAPI,
  platforms: NotifyPlatform[],
  config: NotifyConfig,
  cwd: string,
  dispatch: DispatchNotification,
): void {
  if (pendingWorkSuppressedDone) return; // already armed
  pendingWorkSuppressedDone = true;
  unsubPendingWorkWatch?.();
  unsubPendingWorkWatch = subscribeWorkChanges(() => {
    if (hasPendingWakeTask() || hasPendingWork()) return;
    if (allDoneTimer) return; // grace already running
    // UNI-221: the work that just cleared (a bg task with a wake, a
    // background subagent, a fusion handoff) usually wakes pi in a fresh
    // turn — that turn's own agent_end/agent_settled is the real "finished".
    // Wait a short grace; if a turn started (agent_start disarms this
    // watcher) or work is pending again, send nothing here.
    allDoneTimer = setTimeout(() => {
      allDoneTimer = undefined;
      if (!pendingWorkSuppressedDone || agentRunning) return;
      if (hasPendingWakeTask() || hasPendingWork()) return;
      sendAllDone();
    }, ALL_DONE_GRACE_MS);
    allDoneTimer.unref?.();
  });
  const sendAllDone = () => {
    // Everything cleared and nothing woke pi: send ONE "All done" and disarm.
    pendingWorkSuppressedDone = false;
    unsubPendingWorkWatch?.();
    unsubPendingWorkWatch = undefined;
    const sessionName = pi.getSessionName?.();
    const title = "Pi — All Done";
    const message = sessionName ? `${sessionName} - All pending work finished` : "All pending work finished";
    dispatch(pi, title, message, platforms, "agent_settled", config, cwd, "low").catch(() => {
      // Silently ignore — background agent notification failure is non-blocking.
    });
  };
}

/** UNI-221: disarm the "All done" watcher — a fresh turn started, so its own
 *  settle decides whether the session is finished (or pending again). */
function disarmAllDoneWatch(): void {
  pendingWorkSuppressedDone = false;
  unsubPendingWorkWatch?.();
  unsubPendingWorkWatch = undefined;
  if (allDoneTimer) clearTimeout(allDoneTimer);
  allDoneTimer = undefined;
}

/**
 * UNI-223: how long after a run settles the "finished" notification waits
 * for a chained run before it goes out. pi starts a fresh run right at the
 * settle for a queued follow-up, a goal/kanboard continuation or a phone's
 * "after it ends" message; that run's own settle is the real finish.
 * Exported for tests.
 */
export const FINISH_GRACE_MS = 1500;
const finishGraceMs = (): number => {
  const raw = process.env.UNIPI_NOTIFY_FINISH_GRACE_MS;
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : FINISH_GRACE_MS;
};

/** Pending "finished" send, cancelled by the next agent_start. */
let finishTimer: ReturnType<typeof setTimeout> | undefined;

function cancelFinish(): void {
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = undefined;
}

/**
 * UNI-223: the "run finished" notification. Before, `agent_end` notified —
 * but pi emits agent_end for EVERY agent loop: each reply, each steer /
 * follow-up continuation, each goal or arbiter nudge. With ntfy on, a phone
 * got a push for every chat change. Now:
 *  - it hooks `agent_settled` only (once per run, after every continuation),
 *    whichever of agent_end / agent_settled the user enabled (one send, not
 *    two, when both are on);
 *  - it waits FINISH_GRACE_MS: a run chained at the settle (agent_start)
 *    cancels it — that run's own settle decides;
 *  - pending wake-capable work (bg task with a wake, subagent, fusion
 *    handoff) still defers to the single "All done" (UNI-162/221).
 */
function registerRunFinishedNotification(
  pi: ExtensionAPI,
  config: NotifyConfig,
  cwd: string,
  dispatch: DispatchNotification = dispatchNotification
): void {
  const eventKey: "agent_end" | "agent_settled" | undefined = config.events.agent_settled?.enabled
    ? "agent_settled"
    : config.events.agent_end?.enabled
      ? "agent_end"
      : undefined;
  cancelFinish();
  if (!eventKey) return;
  const eventConfig = config.events[eventKey]!;
  // Children (subagents, sidekicks) never own the user's "finished".
  if (process.env.UNIPI_SUBAGENT_CHILD === "1" || process.env.UNIPI_FUSION_CHILD === "1") return;

  const notify = registerAgentNotification(pi, eventKey, eventConfig.platforms, config, cwd, dispatch);
  (pi as any).on("agent_start", () => cancelFinish());
  (pi as any).on("agent_settled", (payload: unknown) => {
    cancelFinish();
    finishTimer = setTimeout(() => {
      finishTimer = undefined;
      notify(payload);
    }, finishGraceMs());
    finishTimer.unref?.();
  });
}

/** Build the "finished" sender (session name, recap, pending-work deferral). */
function registerAgentNotification(
  pi: ExtensionAPI,
  eventKey: "agent_end" | "agent_settled",
  platforms: NotifyPlatform[],
  config: NotifyConfig,
  cwd: string,
  dispatch: DispatchNotification = dispatchNotification
): (payload: unknown) => void {
  const eventConfig = { platforms };

  const handler = (payload: unknown) => {
    // A running background task with triggerOnCompletion wakes the agent in a
    // fresh turn that produces its own agent_end/agent_settled. Notifying for
    // this intermediate turn as well would duplicate the wake message.
    //
    // UNI-162: the same applies to a background subagent still running or a
    // non-blocking fusion handoff in flight (core's hasPendingWork(), reading
    // the arbiter's wait sources) — any of those also means this "done" is an
    // intermediate turn. Arm the watcher so the EVENTUAL all-clear sends one
    // "All done" instead of the session going quiet with no notification at
    // all once the last pending thing finishes.
    if (hasPendingWakeTask() || hasPendingWork()) {
      armAllDoneWatch(pi, eventConfig.platforms, config, cwd, dispatch);
      return;
    }

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
                return summarizeLastMessage(lastText, apiKey, model.baseUrl, model.api, modelId, {
                  disableThinking: config.recap.disableThinking,
                })
                  .then((recap) => sessionName ? `${sessionName}: ${recap}` : recap);
              }
              return buildAgentLifecycleMessage(eventKey, sessionName);
            })
            .catch(() => buildAgentLifecycleMessage(eventKey, sessionName))
            .then((message) =>
              dispatch(pi, title, message, eventConfig.platforms, eventKey, config, cwd, "low")
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
    dispatch(pi, title, message, eventConfig.platforms, eventKey, config, cwd, "low").catch(
      () => {
        // Silently ignore — background agent notification failure is non-blocking.
      }
    );
  };

  return handler;
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
