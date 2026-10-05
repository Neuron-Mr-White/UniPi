/**
 * @pi-unipi/watchdog — Settings
 *
 * Namespace `watchdog` in the engine (~/.unipi/config/watchdog/config.json),
 * edited via /unipi:settings (Watchdog group).
 */

import { getSettings, registerSettings, decisionModelSection, DEFAULT_DECISION_OVERRIDE } from "@pi-unipi/core";

export type WatchdogAction = "background" | "kill" | "warn";
export type OtherToolsMode = "off" | "warn" | "abort-turn";

export interface WatchdogSettings {
  /** Master switch (default: off). */
  enabled: boolean;
  /** Minutes between checks of every watched item (default: 5). */
  intervalMin: number;
  /** Minutes until the first check after session start (default: 2). */
  firstCheckMin: number;
  /** Minimum jev confidence for a kill/warn decision (default: 0.8). */
  confidence: number;
  /** Consecutive agreeing checks before acting (default: 2). */
  agreeChecks: number;
  /** background a stuck bash call, kill it, or only warn (default: background). */
  action: WatchdogAction;
  /** Watch pi's bash tool calls (default: true). */
  watchBash: boolean;
  /** Watch background tasks (default: true). */
  watchBgTasks: boolean;
  /** Tools without a kill handle: off | warn | abort-turn (default: warn). */
  otherTools: OtherToolsMode;
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = {
  enabled: false,
  intervalMin: 5,
  firstCheckMin: 2,
  confidence: 0.8,
  agreeChecks: 2,
  action: "background",
  watchBash: true,
  watchBgTasks: true,
  otherTools: "warn",
};

function num(v: unknown, fallback: number, min: number, max?: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) return fallback;
  if (max !== undefined && v > max) return fallback;
  return v;
}

/** Load watchdog settings from the engine, defaults merged. */
export function loadWatchdogSettings(cwd: string): WatchdogSettings {
  try {
    const parsed = getSettings("watchdog", cwd) as Record<string, unknown>;
    const action =
      parsed?.action === "warn" ? "warn" :
      parsed?.action === "kill" ? "kill" :
      parsed?.action === "background" ? "background" :
      DEFAULT_WATCHDOG_SETTINGS.action;
    const otherTools =
      parsed?.otherTools === "warn" || parsed?.otherTools === "abort-turn" || parsed?.otherTools === "off"
        ? (parsed.otherTools as OtherToolsMode)
        : DEFAULT_WATCHDOG_SETTINGS.otherTools;
    return {
      enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : DEFAULT_WATCHDOG_SETTINGS.enabled,
      intervalMin: num(parsed?.intervalMin, DEFAULT_WATCHDOG_SETTINGS.intervalMin, 0.1),
      firstCheckMin: num(parsed?.firstCheckMin, DEFAULT_WATCHDOG_SETTINGS.firstCheckMin, 0),
      confidence: num(parsed?.confidence, DEFAULT_WATCHDOG_SETTINGS.confidence, 0, 1),
      agreeChecks: num(parsed?.agreeChecks, DEFAULT_WATCHDOG_SETTINGS.agreeChecks, 1),
      action,
      watchBash: typeof parsed?.watchBash === "boolean" ? parsed.watchBash : DEFAULT_WATCHDOG_SETTINGS.watchBash,
      watchBgTasks:
        typeof parsed?.watchBgTasks === "boolean" ? parsed.watchBgTasks : DEFAULT_WATCHDOG_SETTINGS.watchBgTasks,
      otherTools,
    };
  } catch {
    return { ...DEFAULT_WATCHDOG_SETTINGS };
  }
}

/** Register the watchdog settings namespace + hub section. */
export function registerWatchdogSettings(cwd: string): void {
  registerSettings({
    namespace: "watchdog",
    label: "Watchdog",
    defaults: { ...DEFAULT_WATCHDOG_SETTINGS, decisionModel: DEFAULT_DECISION_OVERRIDE } as unknown as Record<string, unknown>,
    schema: [
      {
        title: "Watchdog",
        description: "Jev judges long-running tool calls and background tasks; kills or warns when stuck",
        fields: [
          { key: "enabled", type: "boolean", label: "Enabled", description: "Watch long-running bash calls and background tasks with jev; off runs no timers." },
          { key: "intervalMin", type: "number", label: "Check interval", unit: "min", min: 0.1, description: "Every watched item is judged once per interval." },
          { key: "firstCheckMin", type: "number", label: "First check after", unit: "min", min: 0, description: "Delay before the first check; 0 checks right away." },
          { key: "confidence", type: "number", label: "Confidence", min: 0, max: 1, description: "Minimum jev confidence to act." },
          { key: "agreeChecks", type: "number", label: "Agreeing checks", min: 1, description: "Consecutive agreeing checks before the action fires." },
          {
            key: "action",
            type: "enum",
            label: "Action",
            description: "What happens when the watchdog is confident something is stuck.",
            options: [
              { value: "background", label: "background", description: "move a stuck bash call to a background task instead of killing it; falls back to kill if that is unavailable" },
              { value: "kill", label: "kill", description: "kill the stuck item" },
              { value: "warn", label: "warn", description: "notify you and leave it running" },
            ],
          },
          { key: "watchBash", type: "boolean", label: "Watch bash", description: "Watch bash tool calls as well as background tasks." },
          { key: "watchBgTasks", type: "boolean", label: "Watch background tasks", description: "Servers (no completion triggers) are never checked." },
          {
            key: "otherTools",
            type: "enum",
            label: "Other tools",
            description: "What happens to tools that cannot be killed (web, image, mcp, subagents) when they look stuck.",
            options: [
              { value: "off", label: "off", description: "leave other tools unwatched" },
              { value: "warn", label: "warn", description: "notify and inject a message" },
              { value: "abort-turn", label: "abort turn", description: "abort the running turn" },
            ],
          },
        ],
      },
      decisionModelSection({ title: "Watchdog — Decision model" }),
    ],
  });
}
