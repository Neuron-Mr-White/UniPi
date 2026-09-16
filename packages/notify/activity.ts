/**
 * @pi-unipi/notify — Recent terminal-input activity
 *
 * Tracks the last interactive keypress so dispatch can silence selected
 * platforms while the user is at the keyboard.
 */

import type {
  NotifyConfig,
  NotifyPlatform,
  SilenceAfterInputConfig,
} from "./types.js";

/** Known platform names — unknown strings are dropped when merging config. */
const VALID_PLATFORMS: ReadonlySet<NotifyPlatform> = new Set([
  "native",
  "gotify",
  "telegram",
  "ntfy",
]);

/**
 * Events where a human is blocking the session. They arrive seconds after the
 * keypress that caused them, so recent input must never mute them.
 */
const BLOCKING_EVENTS: ReadonlySet<string> = new Set([
  "ask_user_prompt",
  "permission_request",
]);

/** Whether an event type is a human-blocking prompt. */
export function isBlockingEvent(eventType: string | undefined): boolean {
  return eventType !== undefined && BLOCKING_EVENTS.has(eventType);
}

let lastInputAt = 0;

/** Record a terminal keypress. `at` is injectable for tests. */
export function noteInput(at: number = Date.now()): void {
  lastInputAt = at;
}

/** Clear activity (session start/shutdown). */
export function resetInputActivity(): void {
  lastInputAt = 0;
}

/**
 * Split already-enabled platforms into "send" vs "silenced by recent input".
 * Does not look at platform `enabled` flags — caller filters those first.
 * Empty `platforms` (while enabled) silences all incoming channels, matching
 * `events.*.platforms: []` → all enabled.
 *
 * Human-blocking events (`ask_user_prompt`, `permission_request`) bypass the
 * filter entirely — the keypress that triggered them must not mute them.
 */
export function filterPlatformsAfterInput(
  platforms: NotifyPlatform[],
  config: Pick<NotifyConfig, "silenceAfterInput">,
  now: number = Date.now(),
  eventType?: string,
): { send: NotifyPlatform[]; silenced: NotifyPlatform[] } {
  if (isBlockingEvent(eventType)) {
    return { send: platforms.slice(), silenced: [] };
  }
  const cfg = config.silenceAfterInput;
  if (!shouldSilence(cfg, now)) {
    return { send: platforms.slice(), silenced: [] };
  }
  if (cfg.platforms.length === 0) {
    return { send: [], silenced: platforms.slice() };
  }
  const silent = new Set(cfg.platforms);
  const send: NotifyPlatform[] = [];
  const silenced: NotifyPlatform[] = [];
  for (const platform of platforms) {
    if (silent.has(platform)) silenced.push(platform);
    else send.push(platform);
  }
  return { send, silenced };
}

/** Normalize a partial config blob against defaults. */
export function mergeSilenceAfterInput(
  loaded: Partial<SilenceAfterInputConfig> | undefined,
  defaults: SilenceAfterInputConfig,
): SilenceAfterInputConfig {
  if (!loaded) {
    return {
      enabled: defaults.enabled,
      windowMs: defaults.windowMs,
      platforms: defaults.platforms.slice(),
    };
  }
  const platforms = Array.isArray(loaded.platforms)
    ? loaded.platforms.filter((p): p is NotifyPlatform =>
        VALID_PLATFORMS.has(p as NotifyPlatform),
      )
    : defaults.platforms.slice();
  const windowMs =
    typeof loaded.windowMs === "number" &&
    Number.isFinite(loaded.windowMs) &&
    loaded.windowMs >= 0
      ? loaded.windowMs
      : defaults.windowMs;
  return {
    enabled: loaded.enabled ?? defaults.enabled,
    windowMs,
    platforms,
  };
}

function shouldSilence(
  cfg: SilenceAfterInputConfig | undefined,
  now: number,
): cfg is SilenceAfterInputConfig {
  if (!cfg?.enabled) return false;
  if (lastInputAt <= 0) return false;
  if (now - lastInputAt >= cfg.windowMs) return false;
  return true;
}
