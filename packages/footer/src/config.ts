/**
 * @pi-unipi/footer — Configuration
 *
 * Footer settings live in the unified engine layout:
 *   global  ~/.unipi/config/footer/config.json
 *   project <cwd>/.unipi/config/footer/config.json   (workspace wins)
 *
 * Old v2 keys (`preset`, `separator`, `zoneSeparator`, `showFullLabels`,
 * `groups`, `glanceMode`) are simply ignored — unknown keys never crash.
 * Legacy `colorMode: "mono"` loads as `"none"`.
 *
 * Loads are cached in memory (getSettings reads two files per call and the
 * strip paints every second). The cache invalidates on every engine write
 * (`onSet`) and re-stats the config files at most once per second so external
 * edits are picked up too.
 */

import { statSync } from "node:fs";
import {
  getSettings,
  globalSettingsPath,
  projectSettingsPath,
  registerSettings,
  setSettings,
} from "@pi-unipi/core";
import type { BadgeToggles, ColorMode, FooterSettings, IconStyle, RainbowMode, StripToggles } from "./types.js";
import { setIconStyle } from "./rendering/icons.js";

/** Default footer settings */
export const DEFAULT_FOOTER_SETTINGS: FooterSettings = {
  enabled: true,
  iconStyle: "nerd",
  colorMode: "auto",
  rainbow: "always",
  processLine: true,
  strip: {
    turns: true,
    time: true,
    speed: true,
    tokens: true,
    cost: true,
    compactions: true,
    cache: true,
  },
  badges: {
    mode: true,
    planPermission: true,
    fusion: true,
    kanboard: true,
  },
};

const COLOR_MODES: readonly ColorMode[] = ["auto", "truecolor", "256", "none"];
const RAINBOW_MODES: readonly RainbowMode[] = ["always", "brand-only", "off"];
const ICON_STYLES: readonly IconStyle[] = ["nerd", "emoji", "text"];

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toggles<T>(value: unknown, defaults: T): T {
  const out = { ...defaults } as Record<string, boolean>;
  if (typeof value === "object" && value !== null) {
    const raw = value as Record<string, unknown>;
    for (const key of Object.keys(defaults as Record<string, boolean>)) {
      out[key] = bool(raw[key], (defaults as Record<string, boolean>)[key]);
    }
  }
  return out as T;
}

/** Registered with the unified settings hub — /unipi:settings → Footer. */
registerSettings({
  namespace: "footer",
  label: "Footer",
  defaults: DEFAULT_FOOTER_SETTINGS as unknown as Record<string, unknown>,
  onSet: () => {
    // Hub/command writes land here — keep the load cache coherent and give
    // the frame's next paint the new icon style.
    invalidateFooterSettingsCache();
    setIconStyle(loadFooterSettings().iconStyle);
  },
  schema: [
    {
      title: "General",
      fields: [
        { key: "enabled", type: "boolean", label: "Footer enabled", description: "The glance frame, stats strip and process line. Off leaves the plain pi editor." },
        {
          key: "colorMode",
          type: "enum",
          label: "Color mode",
          plainOptions: true,
          description: "How much color the footer emits.",
          options: ["auto", "truecolor", "256", "none"],
        },
        {
          key: "iconStyle",
          type: "enum",
          label: "Icon style",
          description: "Glyph set for the brand and frame titles.",
          options: [
            { value: "emoji", label: "emoji", description: "emoji glyphs, always render" },
            { value: "nerd", label: "nerd font", description: "nerd-font glyphs, need a patched font" },
            { value: "text", label: "text only", description: "no icons, plain text labels" },
          ],
        },
      ],
    },
    {
      title: "Glance",
      description: "The stats strip below the input and the frame badges.",
      fields: [
        {
          key: "rainbow",
          type: "enum",
          label: "Rainbow",
          plainOptions: true,
          description: "Which frame parts get the animated rainbow.",
          options: ["always", "brand-only", "off"],
        },
        { key: "processLine", type: "boolean", label: "Background tasks line", description: "The one-liner above the input counting background tasks." },
        { key: "strip.turns", type: "boolean", label: "Strip: turns", description: "Turn and step counters in the stats strip." },
        { key: "strip.time", type: "boolean", label: "Strip: time", description: "Model time and tool time in the stats strip." },
        { key: "strip.speed", type: "boolean", label: "Strip: speed", description: "Average time to first token and tokens per second." },
        { key: "strip.tokens", type: "boolean", label: "Strip: tokens", description: "Session input and output token totals." },
        { key: "strip.cost", type: "boolean", label: "Strip: cost", description: "Session cost, or sub on subscription models." },
        { key: "strip.compactions", type: "boolean", label: "Strip: compactions", description: "Compaction count, sizes and recency." },
        { key: "strip.cache", type: "boolean", label: "Strip: cache", description: "Cache hit percentage." },
        { key: "badges.mode", type: "boolean", label: "Badge: mode", description: "Long-horizon mode label beside the brand." },
        { key: "badges.planPermission", type: "boolean", label: "Badge: plan/permission", description: "PLAN badge and permission mode in the top border." },
        { key: "badges.fusion", type: "boolean", label: "Badge: fusion", description: "Fusion lead and sidekick in the bottom border." },
        { key: "badges.kanboard", type: "boolean", label: "Badge: kanboard", description: "Kanboard claims label in the top border." },
      ],
    },
  ],
});

// ─── Load (cached) ──────────────────────────────────────────────────────────

interface SettingsCache {
  value: FooterSettings;
  /** Wall time of the last check. */
  checkedAt: number;
  /** mtime stamp of both config files at load time. */
  stamp: string;
}

let cache: SettingsCache | null = null;

/** Re-stat at most once per second; a load within that window is free. */
const FRESH_MS = 1000;

function configFileStamp(cwd: string): string {
  let stamp = "";
  for (const file of [globalSettingsPath("footer"), projectSettingsPath(cwd, "footer")]) {
    try {
      stamp += `${statSync(file).mtimeMs};`;
    } catch {
      stamp += "-1;";
    }
  }
  return stamp;
}

/** Read + validate settings from the engine, falling back to defaults. */
function readFooterSettings(): FooterSettings {
  let footer: Record<string, unknown>;
  try {
    footer = getSettings("footer", process.cwd());
  } catch {
    return structuredClone(DEFAULT_FOOTER_SETTINGS);
  }
  const colorModeRaw = footer.colorMode;
  // Legacy "mono" (offered by the old hub, never understood by the code)
  // means no color.
  const colorMode: ColorMode =
    colorModeRaw === "mono" ? "none"
      : COLOR_MODES.includes(colorModeRaw as ColorMode) ? colorModeRaw as ColorMode
        : DEFAULT_FOOTER_SETTINGS.colorMode;
  const rainbow = RAINBOW_MODES.includes(footer.rainbow as RainbowMode)
    ? footer.rainbow as RainbowMode
    : DEFAULT_FOOTER_SETTINGS.rainbow;
  return {
    enabled: bool(footer.enabled, DEFAULT_FOOTER_SETTINGS.enabled),
    iconStyle: ICON_STYLES.includes(footer.iconStyle as IconStyle)
      ? footer.iconStyle as IconStyle
      : DEFAULT_FOOTER_SETTINGS.iconStyle,
    colorMode,
    rainbow,
    processLine: bool(footer.processLine, DEFAULT_FOOTER_SETTINGS.processLine),
    strip: toggles(footer.strip, DEFAULT_FOOTER_SETTINGS.strip),
    badges: toggles(footer.badges, DEFAULT_FOOTER_SETTINGS.badges),
  };
}

/**
 * Load footer settings. Cached in memory; re-checks the config files' mtime
 * at most once per second, and `saveFooterSettings`/hub writes invalidate
 * immediately.
 */
export function loadFooterSettings(): FooterSettings {
  const now = Date.now();
  if (cache && now - cache.checkedAt < FRESH_MS) return cache.value;
  const cwd = process.cwd();
  const stamp = configFileStamp(cwd);
  if (cache && stamp === cache.stamp) {
    cache.checkedAt = now;
    return cache.value;
  }
  const value = readFooterSettings();
  cache = { value, checkedAt: now, stamp };
  return value;
}

/** Drop the memoized settings so the next load re-reads the engine. */
export function invalidateFooterSettingsCache(): void {
  cache = null;
}

/**
 * Save footer settings to the global layer.
 * Merges with existing settings (preserves other keys).
 */
export function saveFooterSettings(partial: Partial<FooterSettings>): boolean {
  try {
    setSettings("footer", partial as Record<string, unknown>, "global", process.cwd());
    return true;
  } catch {
    return false;
  }
}
