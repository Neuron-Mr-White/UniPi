/**
 * @pi-unipi/core — info tips (event-based onboarding hints)
 *
 * Modules register one-line tips via registerTips(); installTips() mounts the
 * engine: ONE startup tip at session_start (least-shown, least-recent wins),
 * event tips on matching pi/UNIPI events. Rendered as a dim `💡` line above
 * the editor (same widget placement as the /unipi:answer hint), cleared when
 * the next turn starts. Show counts persist in ~/.unipi/global/tips/tips.json.
 *
 *   Tip = { id, text, when: "startup" | { event, match? }, maxShows? }
 *   maxShows default: 3 for startup tips, 2 for event tips.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettings, registerSettings } from "../settings/engine.js";
import { registerCommandRunner } from "../../command-runner.js";
import { hubDimText } from "../tui/hub-kit.js";
import { loadTipCounts, recordTipShow, resetTipCounts } from "./store.js";

export interface TipEventWhen {
  /** pi event name ("tool_call", "session_compact", …) or a UNIPI_EVENTS name. */
  event: string;
  /** Optional payload filter. */
  match?: (payload: unknown) => boolean;
}

export interface Tip {
  /** Stable unique id, e.g. "memory.search-first". */
  id: string;
  /** One line, ≤110 chars, naming the real command/key/setting. */
  text: string;
  when: "startup" | TipEventWhen;
  maxShows?: number;
}

export const TIP_MAX_STARTUP = 3;
export const TIP_MAX_EVENT = 2;

const WIDGET = "unipi-tips";
const RESET_COMMAND = "unipi:tips-reset";

// ─── registry ───────────────────────────────────────────────────────────────

interface RegisteredTip extends Tip {
  module: string;
}

const registry: RegisteredTip[] = [];

export function registerTips(module: string, tips: Tip[]): void {
  for (const tip of tips) registry.push({ ...tip, module });
}

export function listTips(): readonly RegisteredTip[] {
  return registry;
}

/** Test hook. */
export function resetTipRegistry(): void {
  registry.length = 0;
}

// ─── selection ──────────────────────────────────────────────────────────────

const maxShows = (tip: Tip): number => tip.maxShows ?? (tip.when === "startup" ? TIP_MAX_STARTUP : TIP_MAX_EVENT);

/** Pick the least-shown, then least-recent, then first-registered startup tip. */
export function pickStartupTip(
  tips: readonly Tip[],
  counts: Record<string, { count: number; last: number }>,
): Tip | null {
  let best: Tip | null = null;
  let bestCount = Infinity;
  let bestLast = Infinity;
  for (const tip of tips) {
    if (tip.when !== "startup") continue;
    const rec = counts[tip.id];
    const count = rec?.count ?? 0;
    if (count >= maxShows(tip)) continue;
    const last = rec?.last ?? 0;
    if (count < bestCount || (count === bestCount && last < bestLast)) {
      best = tip;
      bestCount = count;
      bestLast = last;
    }
  }
  return best;
}

/** First event tip still under maxShows that matches this payload. */
export function pickEventTip(
  tips: readonly Tip[],
  event: string,
  payload: unknown,
  counts: Record<string, { count: number; last: number }>,
): Tip | null {
  for (const tip of tips) {
    if (tip.when === "startup" || tip.when.event !== event) continue;
    const count = counts[tip.id]?.count ?? 0;
    if (count >= maxShows(tip)) continue;
    if (tip.when.match && !tip.when.match(payload)) continue;
    return tip;
  }
  return null;
}

// ─── engine ─────────────────────────────────────────────────────────────────

/** pi core events the engine subscribes via pi.on; anything else goes through
 *  the unipi bus (pi.events). Keep in sync with lines.ts triggers. */
const PI_EVENTS = new Set(["session_compact", "tool_call", "agent_end", "model_select", "input"]);

interface TipsConfig {
  enabled: boolean;
}

registerSettings({
  namespace: "tips",
  label: "Tips",
  defaults: { enabled: true },
  schema: [
    {
      title: "Info tips",
      fields: [
        {
          key: "enabled",
          type: "boolean",
          label: "Info tips",
          description: "Dim 💡 one-liners above the editor on startup and matching events.",
        },
        {
          key: "reset",
          type: "action",
          label: "Reset tip history",
          description: "Clear show counts — every tip becomes eligible again.",
          command: RESET_COMMAND,
        },
      ],
    },
  ],
});

export function tipsEnabled(cwd: string): boolean {
  try {
    const cfg = getSettings("tips", cwd) as Partial<TipsConfig>;
    return cfg.enabled !== false;
  } catch {
    return true;
  }
}

export function installTips(pi: ExtensionAPI): void {
  // Content registers itself on import.
  void import("./lines.js");

  let activeTip: string | null = null;
  /** Latest UI-capable ctx — pi.events handlers carry no ctx. */
  let sessionCtx: ExtensionContext | null = null;
  /** input() dispatch counter — an input-triggered tip belongs to the turn it
   *  just opened, so before_agent_start (the "next turn starts" clearer) must
   *  not wipe it milliseconds later. */
  let inputSeq = 0;
  let shownSeq = -1;

  const show = (ctx: ExtensionContext, tip: Tip): void => {
    if (!ctx.hasUI || !tipsEnabled(ctx.cwd)) return;
    recordTipShow(tip.id);
    activeTip = tip.id;
    shownSeq = inputSeq;
    try {
      ctx.ui.setWidget(WIDGET, [hubDimText(`  💡 ${tip.text}`)], { placement: "aboveEditor" });
    } catch {
      // cosmetic
    }
  };

  const clear = (ctx: ExtensionContext): void => {
    if (activeTip === null) return;
    activeTip = null;
    shownSeq = -1;
    try {
      ctx.ui.setWidget(WIDGET, undefined);
    } catch {
      // cosmetic
    }
  };

  pi.on("session_start", (_event, ctx) => {
    sessionCtx = ctx;
    activeTip = null;
    if (!ctx.hasUI || !tipsEnabled(ctx.cwd)) return;
    const tip = pickStartupTip(registry, loadTipCounts());
    if (tip) show(ctx, tip);
  });

  // Event subscriptions — lazily from the registered tips (lines.js may import
  // async, so subscribe for every event name seen at handler time too).
  const subscribed = new Set<string>();
  const eventTips = () => registry.filter((t): t is RegisteredTip & { when: TipEventWhen } => t.when !== "startup");

  const fireEvent = (name: string, payload: unknown): void => {
    const ctx = sessionCtx;
    if (!ctx || !ctx.hasUI || !tipsEnabled(ctx.cwd)) return;
    const tip = pickEventTip(registry, name, payload, loadTipCounts());
    if (tip) show(ctx, tip);
  };

  const wireEvents = () => {
    for (const tip of eventTips()) {
      const name = tip.when.event;
      if (subscribed.has(name)) continue;
      subscribed.add(name);
      if (PI_EVENTS.has(name)) {
        pi.on(name as "tool_call", (event: { toolName?: string }) => fireEvent(name, event));
      } else {
        pi.events?.on?.(name, (payload: unknown) => fireEvent(name, payload));
      }
    }
  };

  // A fresh turn clears the tip — same lifecycle as the answer hint.
  // Registered BEFORE wireEvents() so on an `input` dispatch the old tip
  // clears first and only then does a matching input tip show.
  pi.on("input", (_event, ctx) => {
    inputSeq += 1;
    clear(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (shownSeq !== inputSeq) clear(ctx);
  });

  // lines.js resolves async — wire once now and again on the first
  // session_start so late-registered tips still subscribe.
  wireEvents();
  pi.on("session_start", () => wireEvents());

  pi.on("session_shutdown", () => {
    sessionCtx = null;
    activeTip = null;
  });

  registerCommandRunner(RESET_COMMAND, (rawCtx) => {
    resetTipCounts();
    try {
      (rawCtx as ExtensionContext).ui?.notify?.("Tip history cleared — every tip is eligible again.", "info");
    } catch {
      // headless
    }
  });
  pi.registerCommand(RESET_COMMAND, {
    description: "Reset info-tip show counts so every tip is eligible again",
    handler: async (_args, ctx) => {
      resetTipCounts();
      ctx.ui.notify("Tip history cleared — every tip is eligible again.", "info");
    },
  });
}
