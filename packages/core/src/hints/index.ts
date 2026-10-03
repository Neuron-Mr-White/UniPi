/**
 * @pi-unipi/core — hints system with Unicrab mascot (UNI-27)
 *
 * Modules register hints via registerHints(); installHints() mounts the engine:
 *   - Startup hint at session_start (whatsnew first if version bumped, else least-shown/least-recent)
 *   - Derived event triggers (context-high, long-bash, tool-errors, long-prompt, remember, image-input)
 *   - Real pi and unipi bus events
 *   - Caps: startup maxShows 3, event maxShows 2, max 4 event hints per session, no replacement in same turn
 *   - Widget: one text row with 7-column Unicrab mascot (half-blocks or opt-in Kitty image)
 *   - Shortcuts: Alt+H (next startup hint), Alt+Shift+H (prev)
 *   - Command: /unipi:hint (overlay browser, next, reset)
 *   - Settings: namespace "hints" (enabled, header, crab, reset)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  encodeKitty,
  deleteKittyImage,
  getCapabilities,
  truncateToWidth,
  visibleWidth,
  Key,
  type TUI,
} from "@earendil-works/pi-tui";
import { getSettings, registerSettings } from "../settings/engine.js";
import { registerCommandRunner } from "../../command-runner.js";
import { hubDimText } from "../tui/hub-kit.js";
import { getInstalledPackageVersion, getPiVersion, compareVersions } from "../../utils.js";
import {
  loadHintStore,
  recordHintShow,
  recordHintLearned,
  isHintLearned,
  getLastSeenVersion,
  setLastSeenVersion,
  resetHintHistory,
} from "./store.js";
import {
  CRAB_KITTY_PNG_BASE64,
  CRAB_22_LINES_TRUECOLOR,
  CRAB_22_LINES_256,
  CRAB_14_LINES_TRUECOLOR,
  CRAB_14_LINES_256,
} from "./crab-data.js";
import { renderHintBrowser } from "./browser.js";

export type HintCategory =
  | "command"
  | "shortcut"
  | "setting"
  | "capability"
  | "explain"
  | "trouble"
  | "whatsnew"
  | "workflow"
  | "lore";

export interface HintEventWhen {
  event: string;
  match?: (payload: unknown) => boolean;
}

export interface Hint {
  id: string;
  category: HintCategory;
  text: string;
  when: "startup" | HintEventWhen;
  maxShows?: number;
  teaches?: string;
  since?: string;
}

export const HINT_MAX_STARTUP = 3;
export const HINT_MAX_EVENT = 2;
export const HINT_MAX_SESSION_EVENTS = 4;
export const UNICRAB_KITTY_IMAGE_ID = 0x554e4943;
export const WIDGET_KEY = "unipi-hints";

const RESET_COMMAND = "unipi:hint-reset";

// ─── registry ───────────────────────────────────────────────────────────────

const registry: Hint[] = [];

export function registerHints(hints: readonly Hint[]): void {
  for (const h of hints) {
    if (!registry.some((existing) => existing.id === h.id)) {
      registry.push(h);
    }
  }
}

export function listHints(): readonly Hint[] {
  return registry;
}

export function resetHintRegistry(): void {
  registry.length = 0;
}

// ─── selection ──────────────────────────────────────────────────────────────

export const maxShows = (hint: Hint): number =>
  hint.maxShows ?? (hint.when === "startup" ? HINT_MAX_STARTUP : HINT_MAX_EVENT);

/** Pick least-shown, then least-recent startup hint. Excludes lore, whatsnew and learned. */
export function pickStartupHint(
  hints: readonly Hint[],
  counts: Record<string, { count: number; last: number }>,
  learned: readonly string[],
): Hint | null {
  let best: Hint | null = null;
  let bestCount = Infinity;
  let bestLast = Infinity;

  for (const hint of hints) {
    if (hint.when !== "startup") continue;
    if (hint.category === "lore" || hint.category === "whatsnew") continue;
    if (learned.includes(hint.id)) continue;

    const rec = counts[hint.id];
    const count = rec?.count ?? 0;
    if (count >= maxShows(hint)) continue;

    const last = rec?.last ?? 0;
    if (count < bestCount || (count === bestCount && last < bestLast)) {
      best = hint;
      bestCount = count;
      bestLast = last;
    }
  }
  return best;
}

/** Pick a whatsnew hint whose since version is > lastSeen and <= currentVersion. */
export function pickWhatsNewHint(
  hints: readonly Hint[],
  lastSeen: string,
  currentVersion: string,
  counts: Record<string, { count: number; last: number }>,
  learned: readonly string[],
): Hint | null {
  let best: Hint | null = null;
  let bestCount = Infinity;
  let bestLast = Infinity;

  for (const hint of hints) {
    if (hint.category !== "whatsnew" || !hint.since) continue;
    if (learned.includes(hint.id)) continue;
    if (compareVersions(hint.since, lastSeen) <= 0) continue;
    if (compareVersions(hint.since, currentVersion) > 0) continue;

    const rec = counts[hint.id];
    const count = rec?.count ?? 0;
    if (count >= maxShows(hint)) continue;

    const last = rec?.last ?? 0;
    if (count < bestCount || (count === bestCount && last < bestLast)) {
      best = hint;
      bestCount = count;
      bestLast = last;
    }
  }
  return best;
}

/** First matching event hint under its cap. */
export function pickEventHint(
  hints: readonly Hint[],
  event: string,
  payload: unknown,
  counts: Record<string, { count: number; last: number }>,
  learned: readonly string[],
): Hint | null {
  for (const hint of hints) {
    if (hint.when === "startup" || hint.when.event !== event) continue;
    if (learned.includes(hint.id)) continue;

    const count = counts[hint.id]?.count ?? 0;
    if (count >= maxShows(hint)) continue;

    if (hint.when.match && !hint.when.match(payload)) continue;
    return hint;
  }
  return null;
}

/** Cycle pool: only when: "startup" hints that are non-learned (including lore and whatsnew). */
export function pickNextCycleHint(
  hints: readonly Hint[],
  currentActiveId: string | null,
  counts: Record<string, { count: number; last: number }>,
  learned: readonly string[],
): Hint | null {
  const eligible = hints.filter((h) => h.when === "startup" && !learned.includes(h.id));
  if (eligible.length === 0) return null;

  const sorted = [...eligible].sort((a, b) => {
    const ca = counts[a.id]?.count ?? 0;
    const cb = counts[b.id]?.count ?? 0;
    if (ca !== cb) return ca - cb;
    const la = counts[a.id]?.last ?? 0;
    const lb = counts[b.id]?.last ?? 0;
    if (la !== lb) return la - lb;
    return hints.indexOf(a) - hints.indexOf(b);
  });

  if (currentActiveId) {
    const candidate = sorted.find((h) => h.id !== currentActiveId);
    if (candidate) return candidate;
  }
  return sorted[0] ?? null;
}

// ─── mascot & widget rendering ──────────────────────────────────────────────

export function isImageLine(line: string): boolean {
  return (
    line.startsWith("\x1b_G") ||
    line.startsWith("\x1b]1337;File=") ||
    line.includes("\x1b_G") ||
    line.includes("\x1b]1337;File=")
  );
}

/**
 * Auto resolves to blocks always (Kitty image mode is opt-in because overlay
 * compositors cannot draw over Kitty image rows).
 */
export function resolveCrabStyle(
  settingStyle: "auto" | "image" | "blocks",
): "image" | "blocks" {
  if (settingStyle === "image") return "image";
  return "blocks";
}

/**
 * 7 columns x 1 row half-block crab glyph in truecolor or 256color:
 *   Top:    R _ R R R _ R  (claws up, carapace)
 *   Bottom: _ R E R E R _  (legs, eyes E, body)
 *
 * Cells:
 *   col0: ▀R
 *   col1: ▄R
 *   col2: ▀ fg R / bg E
 *   col3: █R
 *   col4: ▀ fg R / bg E
 *   col5: ▄R
 *   col6: ▀R
 */
export function renderBlockCrab(trueColor: boolean): string {
  if (trueColor) {
    return (
      "\x1b[38;2;240;48;24m▀\x1b[39m" +
      "\x1b[38;2;240;48;24m▄\x1b[39m" +
      "\x1b[38;2;240;48;24m\x1b[48;2;250;245;170m▀\x1b[39m\x1b[49m" +
      "\x1b[38;2;240;48;24m█\x1b[39m" +
      "\x1b[38;2;240;48;24m\x1b[48;2;250;245;170m▀\x1b[39m\x1b[49m" +
      "\x1b[38;2;240;48;24m▄\x1b[39m" +
      "\x1b[38;2;240;48;24m▀\x1b[39m"
    );
  }
  return (
    "\x1b[38;5;202m▀\x1b[39m" +
    "\x1b[38;5;202m▄\x1b[39m" +
    "\x1b[38;5;202m\x1b[48;5;229m▀\x1b[39m\x1b[49m" +
    "\x1b[38;5;202m█\x1b[39m" +
    "\x1b[38;5;202m\x1b[48;5;229m▀\x1b[39m\x1b[49m" +
    "\x1b[38;5;202m▄\x1b[39m" +
    "\x1b[38;5;202m▀\x1b[39m"
  );
}

export function renderKittyCrab(): string {
  const seq = encodeKitty(CRAB_KITTY_PNG_BASE64, {
    imageId: UNICRAB_KITTY_IMAGE_ID,
    columns: 2,
    rows: 1,
    moveCursor: false,
  });
  return `${seq}  `;
}

/**
 * Single text row for the hint widget:
 *   <crab> <text>  <dim: category · alt+h ›>
 * Truncates text part only, never escape sequences.
 */
export function renderHintLine(
  hint: Hint,
  width: number,
  crabStyle: "auto" | "image" | "blocks",
  trueColor = getCapabilities().trueColor ?? true,
): string {
  const actualStyle = resolveCrabStyle(crabStyle);
  const crab = actualStyle === "image" ? renderKittyCrab() : renderBlockCrab(trueColor);
  const crabWidth = actualStyle === "image" ? 2 : 7;

  const suffixText = `${hint.category} · alt+h ›`;
  const suffix = hubDimText(suffixText);
  const suffixWidth = visibleWidth(suffixText);

  // Layout: crab + " " + text + "  " + suffix
  const room = Math.max(0, width - crabWidth - 1 - 2 - suffixWidth);
  const textTruncated = truncateToWidth(hint.text, room, "…");

  return `${crab} ${textTruncated}  ${suffix}`;
}

// ─── start screen header ────────────────────────────────────────────────────

function renderWordmark(): string {
  // U N I P I (white, cyan, green, yellow, red)
  return (
    "\x1b[1;38;2;255;255;255mU\x1b[0m " +
    "\x1b[1;38;2;40;190;240mN\x1b[0m " +
    "\x1b[1;38;2;90;210;90mI\x1b[0m " +
    "\x1b[1;38;2;250;200;40mP\x1b[0m " +
    "\x1b[1;38;2;240;60;50mI\x1b[0m"
  );
}

function renderWordmark256(): string {
  return (
    "\x1b[1;38;5;15mU\x1b[0m " +
    "\x1b[1;38;5;75mN\x1b[0m " +
    "\x1b[1;38;5;114mI\x1b[0m " +
    "\x1b[1;38;5;221mP\x1b[0m " +
    "\x1b[1;38;5;196mI\x1b[0m"
  );
}

export function renderHeaderLines(
  width: number,
  unipiVersion: string,
  piVersion: string,
  trueColor = getCapabilities().trueColor ?? true,
  loreLine = "Unicrab walks sideways so it can read your diffs from both ends.",
): string[] {
  // When width < 40, return [] so the header takes 0 vertical rows.
  // Note: setHeader is mounted at session_start; if resized below 40 columns,
  // returning [] ensures no wrapping or layout breakage occurs.
  if (width < 40) {
    return [];
  }

  const dim = (s: string) => hubDimText(s);
  const orange = (s: string) => (trueColor ? `\x1b[38;2;240;120;40m${s}\x1b[39m` : `\x1b[38;5;208m${s}\x1b[39m`);
  const wordmark = trueColor ? renderWordmark() : renderWordmark256();

  if (width >= 72) {
    const crabLines = trueColor ? CRAB_22_LINES_TRUECOLOR : CRAB_22_LINES_256;
    const gap = "   ";
    const leftW = 22 + gap.length;
    const rightMax = Math.max(10, width - leftW);

    const rightLines: string[] = [
      `${wordmark}  ${dim(`v${unipiVersion} · pi ${piVersion}`)}`,
      "",
      "Hi, I'm Unicrab.",
      "",
      dim("/unipi:settings  every module's options"),
      dim("Alt+S            shortcut overlay"),
      dim("/unipi:hint      browse every hint"),
      "",
      orange(truncateToWidth(loreLine, rightMax, "…")),
      "",
    ];

    return crabLines.map((crabLine, idx) => {
      const right = rightLines[idx] ?? "";
      return `${crabLine}${gap}${right}`;
    });
  }

  // 40–71 cols
  const crabLines = trueColor ? CRAB_14_LINES_TRUECOLOR : CRAB_14_LINES_256;
  const gap = "  ";
  const leftW = 14 + gap.length;
  const rightMax = Math.max(10, width - leftW);

  const rightLines: string[] = [
    "",
    `${wordmark}  ${dim(`v${unipiVersion}`)}`,
    "",
    truncateToWidth(dim("/unipi:settings · Alt+S · /unipi:hint"), rightMax, ""),
    "",
    "",
  ];

  return crabLines.map((crabLine, idx) => {
    const right = rightLines[idx] ?? "";
    return `${crabLine}${gap}${right}`;
  });
}

// ─── settings namespace "hints" ─────────────────────────────────────────────

interface HintsConfig {
  enabled: boolean;
  header: boolean;
  crab: "auto" | "image" | "blocks";
}

registerSettings({
  namespace: "hints",
  label: "Hints",
  defaults: {
    enabled: true,
    header: true,
    crab: "auto",
  },
  schema: [
    {
      title: "Unicrab hints",
      fields: [
        {
          key: "enabled",
          type: "boolean",
          label: "Hints",
          description: "One-line Unicrab hints above the editor on startup and matching events.",
        },
        {
          key: "header",
          type: "boolean",
          label: "Unicrab start screen",
          description: "Show the Unicrab mascot and welcome banner at startup.",
        },
        {
          key: "crab",
          type: "enum",
          label: "Mascot style",
          description: "How to render the Unicrab mascot in the hint widget.",
          options: [
            { value: "auto", label: "Auto (half-blocks)" },
            { value: "blocks", label: "Blocks (Unicode half-blocks)" },
            { value: "image", label: "Image (Kitty graphics, experimental: overlays can't draw over it)" },
          ],
        },
        {
          key: "reset",
          type: "action",
          label: "Reset hint history",
          description: "Clear show counts and learned state — every hint becomes eligible again.",
          command: RESET_COMMAND,
        },
      ],
    },
  ],
});

export function hintsEnabled(cwd: string): boolean {
  try {
    const cfg = getSettings("hints", cwd) as Partial<HintsConfig>;
    return cfg.enabled !== false;
  } catch {
    return true;
  }
}

export function hintsHeaderEnabled(cwd: string): boolean {
  try {
    const cfg = getSettings("hints", cwd) as Partial<HintsConfig>;
    return cfg.header !== false;
  } catch {
    return true;
  }
}

export function hintsCrabStyle(cwd: string): "auto" | "image" | "blocks" {
  try {
    const cfg = getSettings("hints", cwd) as Partial<HintsConfig>;
    return cfg.crab ?? "auto";
  } catch {
    return "auto";
  }
}

// ─── engine ─────────────────────────────────────────────────────────────────

const PI_EVENTS = new Set([
  "session_compact",
  "session_compact_failed",
  "model_select",
  "user_bash",
  "tool_call",
  "input",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
  "tool_result",
]);

export function installHints(pi: ExtensionAPI): void {
  void import("./lines.js");

  let activeHint: Hint | null = null;
  let sessionCtx: ExtensionContext | null = null;
  let inputSeq = 0;
  let shownSeq = -1;
  let turnHintShownSeq = -1;
  let sessionEventHintsCount = 0;
  let sessionContextHighFired = false;
  let consecutiveToolErrors = 0;
  const bashStarts = new Map<string, number>();

  // Session history stack for Alt+H / Alt+Shift+H
  const history: string[] = [];
  let historyIndex = -1;

  const deleteKitty = (): void => {
    try {
      process.stdout.write(deleteKittyImage(UNICRAB_KITTY_IMAGE_ID));
    } catch {
      // ignore
    }
  };

  const show = (ctx: ExtensionContext, hint: Hint, record = true): void => {
    if (!ctx.hasUI || !hintsEnabled(ctx.cwd)) return;

    if (activeHint && resolveCrabStyle(hintsCrabStyle(ctx.cwd)) === "image") {
      deleteKitty();
    }

    if (record) {
      recordHintShow(hint.id);
    }
    activeHint = hint;
    shownSeq = inputSeq;
    turnHintShownSeq = inputSeq;

    // Track in session history stack
    if (historyIndex === -1 || history[historyIndex] !== hint.id) {
      history.push(hint.id);
      historyIndex = history.length - 1;
    }

    try {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (_tui, _theme) => ({
          render(width: number): string[] {
            const crabStyle = hintsCrabStyle(ctx.cwd);
            const line = renderHintLine(hint, width, crabStyle);
            return [line];
          },
          invalidate() {},
          dispose() {
            if (resolveCrabStyle(hintsCrabStyle(ctx.cwd)) === "image") {
              deleteKitty();
            }
          },
        }),
        { placement: "aboveEditor" },
      );
    } catch {
      // fallback to string array form
      try {
        const crabStyle = hintsCrabStyle(ctx.cwd);
        const line = renderHintLine(hint, 80, crabStyle);
        ctx.ui.setWidget(WIDGET_KEY, [line], { placement: "aboveEditor" });
      } catch {
        // cosmetic
      }
    }
  };

  const clear = (ctx: ExtensionContext): void => {
    if (activeHint === null) return;
    if (resolveCrabStyle(hintsCrabStyle(ctx.cwd)) === "image") {
      deleteKitty();
    }
    activeHint = null;
    shownSeq = -1;
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // cosmetic
    }
  };

  const cycleNext = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !hintsEnabled(ctx.cwd)) return;
    const store = loadHintStore();

    if (historyIndex >= 0 && historyIndex < history.length - 1) {
      historyIndex += 1;
      const nextId = history[historyIndex];
      const hint = registry.find((h) => h.id === nextId);
      if (hint) {
        show(ctx, hint, true);
        return;
      }
    }

    const next = pickNextCycleHint(registry, activeHint?.id ?? null, store.counts, store.learned);
    if (next) {
      show(ctx, next, true);
    }
  };

  const cyclePrev = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !hintsEnabled(ctx.cwd)) return;
    if (historyIndex > 0) {
      historyIndex -= 1;
      const prevId = history[historyIndex];
      const hint = registry.find((h) => h.id === prevId);
      if (hint) {
        show(ctx, hint, false);
      }
    }
  };

  const getInstalledUnipiVer = (cwd: string): string => {
    try {
      const v = getInstalledPackageVersion(cwd, "@pi-unipi/unipi");
      if (v !== "0.0.0") return v;
      const thisDir = new URL(".", import.meta.url).pathname;
      return getInstalledPackageVersion(thisDir, "@pi-unipi/unipi");
    } catch {
      return "0.0.0";
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    activeHint = null;
    sessionEventHintsCount = 0;
    sessionContextHighFired = false;
    consecutiveToolErrors = 0;
    bashStarts.clear();
    history.length = 0;
    historyIndex = -1;
    turnHintShownSeq = -1;

    if (!ctx.hasUI) return;

    // Header installation
    if (hintsHeaderEnabled(ctx.cwd)) {
      const unipiVer = getInstalledUnipiVer(ctx.cwd);
      const piVer = getPiVersion();

      // Pick a random lore line for Line 9
      const loreHints = registry.filter((h) => h.category === "lore");
      const randomLore =
        loreHints.length > 0
          ? loreHints[Math.floor(Math.random() * loreHints.length)].text
          : "Unicrab walks sideways so it can read your diffs from both ends.";

      ctx.ui.setHeader((_tui, _theme) => ({
        render(width: number): string[] {
          return renderHeaderLines(width, unipiVer, piVer, getCapabilities().trueColor ?? true, randomLore);
        },
        invalidate() {},
      }));
    }

    if (!hintsEnabled(ctx.cwd)) return;

    // What's new or startup hint selection
    const store = loadHintStore();
    const currentVersion = getInstalledUnipiVer(ctx.cwd);
    const lastSeen = getLastSeenVersion();

    if (!lastSeen) {
      setLastSeenVersion(currentVersion);
      const tip = pickStartupHint(registry, store.counts, store.learned);
      if (tip) show(ctx, tip);
    } else if (currentVersion !== lastSeen) {
      const whatsNew = pickWhatsNewHint(registry, lastSeen, currentVersion, store.counts, store.learned);
      setLastSeenVersion(currentVersion);
      if (whatsNew) {
        show(ctx, whatsNew);
      } else {
        const tip = pickStartupHint(registry, store.counts, store.learned);
        if (tip) show(ctx, tip);
      }
    } else {
      const tip = pickStartupHint(registry, store.counts, store.learned);
      if (tip) show(ctx, tip);
    }
  });

  const fireEvent = (name: string, payload: unknown): void => {
    const ctx = sessionCtx;
    if (!ctx || !ctx.hasUI || !hintsEnabled(ctx.cwd)) return;
    if (turnHintShownSeq === inputSeq) return; // never replace a hint in the same turn
    if (sessionEventHintsCount >= HINT_MAX_SESSION_EVENTS) return;

    const store = loadHintStore();
    const tip = pickEventHint(registry, name, payload, store.counts, store.learned);
    if (tip) {
      sessionEventHintsCount += 1;
      show(ctx, tip);
    }
  };

  // Wire events lazily
  const subscribed = new Set<string>();
  const wireEvents = () => {
    for (const hint of registry) {
      if (hint.when === "startup") continue;
      const name = hint.when.event;
      if (subscribed.has(name)) continue;
      subscribed.add(name);
      if (PI_EVENTS.has(name)) {
        pi.on(name as "tool_call", (event: unknown) => fireEvent(name, event));
      } else {
        pi.events?.on?.(name, (payload: unknown) => fireEvent(name, payload));
      }
    }
  };

  // Derived event detectors
  pi.on("turn_end", (_event, ctx) => {
    if (!sessionContextHighFired && ctx) {
      try {
        const usage = (ctx as { getContextUsage?: () => { percent?: number } }).getContextUsage?.();
        if (usage?.percent !== undefined && usage.percent >= 70) {
          sessionContextHighFired = true;
          fireEvent("hints:context-high", { percent: usage.percent });
        }
      } catch {
        // ignore
      }
    }
  });

  pi.on("tool_execution_start" as never, (event: { toolCallId?: string; toolName?: string }) => {
    if (event?.toolName === "bash" && event.toolCallId) {
      bashStarts.set(event.toolCallId, Date.now());
    }
  });

  pi.on("tool_execution_end" as never, (event: { toolCallId?: string; toolName?: string }) => {
    if (event?.toolName === "bash" && event.toolCallId) {
      const start = bashStarts.get(event.toolCallId);
      bashStarts.delete(event.toolCallId);
      if (start && Date.now() - start >= 30_000) {
        fireEvent("hints:long-bash", { durationMs: Date.now() - start });
      }
    }
  });

  pi.on("tool_result", (event: { isError?: boolean }) => {
    if (event?.isError) {
      consecutiveToolErrors += 1;
      if (consecutiveToolErrors >= 3) {
        consecutiveToolErrors = 0;
        fireEvent("hints:tool-errors", { count: 3 });
      }
    } else {
      consecutiveToolErrors = 0;
    }
  });

  pi.on("input", (event: { text?: string; images?: unknown[] }, ctx) => {
    inputSeq += 1;
    clear(ctx);

    const text = event?.text ?? "";

    // Usage-aware teaches recording: exact match on first whitespace-delimited token
    if (text) {
      const firstToken = text.trim().split(/\s+/)[0];
      for (const hint of registry) {
        if (hint.teaches && firstToken === hint.teaches) {
          recordHintLearned(hint.id);
        }
      }
    }

    // Derived: long-prompt
    if (text && !text.startsWith("/")) {
      const paragraphs = text.trim().split(/\n\s*\n+/).filter(Boolean);
      if (text.length >= 800 || paragraphs.length >= 3) {
        fireEvent("hints:long-prompt", { length: text.length, paragraphs: paragraphs.length });
      }
    }

    // Derived: remember
    if (text && /\bremember\b/i.test(text)) {
      fireEvent("hints:remember", { text });
    }

    // Derived: image-input
    if (event?.images && event.images.length > 0) {
      fireEvent("hints:image-input", { count: event.images.length });
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (shownSeq !== inputSeq) clear(ctx);
  });

  wireEvents();
  pi.on("session_start", () => wireEvents());

  pi.on("session_shutdown", () => {
    sessionCtx = null;
    activeHint = null;
  });

  // Shortcuts: Alt+H (next), Alt+Shift+H (prev)
  pi.registerShortcut(Key.alt("h"), {
    description: "Next hint (Unicrab)",
    handler: async (ctx) => {
      cycleNext(ctx as ExtensionContext);
    },
  });

  pi.registerShortcut(Key.altShift("h"), {
    description: "Previous hint (Unicrab)",
    handler: async (ctx) => {
      cyclePrev(ctx as ExtensionContext);
    },
  });

  // Reset runner & command
  const doReset = (ctx: ExtensionContext): void => {
    resetHintHistory();
    try {
      ctx.ui?.notify?.("Hint history cleared — every hint is eligible again.", "info");
    } catch {
      // headless
    }
  };

  registerCommandRunner(RESET_COMMAND, (rawCtx) => {
    doReset(rawCtx as ExtensionContext);
  });

  registerCommandRunner("unipi:hint", (rawCtx, args) => {
    const ctx = rawCtx as ExtensionContext;
    const argStr = typeof args === "string" ? args.trim() : "";
    if (argStr === "next") {
      cycleNext(ctx);
    } else if (argStr === "reset") {
      doReset(ctx);
    } else if (ctx.hasUI) {
      void ctx.ui.custom<Hint | null>(
        renderHintBrowser(registry, (selected) => show(ctx, selected)),
        { overlay: true, overlayOptions: () => ({ anchor: "center" }) },
      );
    }
  });

  pi.registerCommand("unipi:hint", {
    description: "Browse and search Unicrab hints, or cycle/reset",
    handler: async (args, ctx) => {
      const argStr = (args ?? "").trim();
      if (argStr === "next") {
        cycleNext(ctx);
      } else if (argStr === "reset") {
        doReset(ctx);
      } else if (ctx.hasUI) {
        void ctx.ui.custom<Hint | null>(
          renderHintBrowser(registry, (selected) => show(ctx, selected)),
          { overlay: true, overlayOptions: () => ({ anchor: "center" }) },
        );
      }
    },
  });
}
