/**
 * @pi-unipi/core — progress entries: `◎ Goal  ██████▒░░░░░  ~55%  turn 4/30`.
 *
 * Written with `pi.appendEntry`, so they persist in the transcript for the user
 * but never reach the model (custom entries are outside the LLM context).
 */

import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { type KitTheme, progressBar } from "./kit.js";

export const PROGRESS_ENTRY = "unipi-progress";

export interface ProgressData {
  /** Leading glyph (◎ goal, ↻ ralph, ▣ kanboard). */
  icon?: string;
  label: string;
  done: number;
  /** Units in progress right now — rendered as the shaded part. */
  active: number;
  total: number;
  /** Count suffix, e.g. "items", "tasks". Omitted → percent. */
  unit?: string;
  /** Estimated by a model rather than counted (prefixes `~`). */
  estimated?: boolean;
  detail?: string;
  summary?: string;
  color?: ThemeColor;
}

const BAR_WIDTH = 20;

export function progressLines(t: KitTheme, d: ProgressData, width: number): string[] {
  const color = d.color ?? "accent";
  const pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
  const count = d.unit ? `${String(d.done)}/${String(d.total)} ${d.unit}` : `${d.estimated ? "~" : ""}${String(pct)}%`;
  const head = [
    `${t.fg(color, d.icon ?? "◎")} ${t.bold(d.label)}`,
    progressBar(t, d.done, d.active, d.total, BAR_WIDTH, color),
    t.fg("text", count),
    d.detail ? t.fg("dim", d.detail) : "",
  ].filter(Boolean).join("  ");
  const out = [truncateToWidth(head, width)];
  if (d.summary) {
    for (const l of wrapTextWithAnsi(t.fg("muted", d.summary.trim()), Math.max(10, width - 2))) out.push(`  ${l}`);
  }
  return out;
}

const registered = new WeakSet<object>();

/** Register the entry renderer once per extension API instance. */
export function registerProgressRenderer(pi: ExtensionAPI): void {
  if (registered.has(pi)) return;
  registered.add(pi);
  try {
    pi.registerEntryRenderer<ProgressData>(PROGRESS_ENTRY, (entry, _opts, theme): Component | undefined => {
      const d = entry.data;
      if (!d) return undefined;
      return { invalidate() {}, render: (w: number) => progressLines(theme as KitTheme, d, w) } satisfies Component;
    });
  } catch {
    /* UI-dependent */
  }
}

export function appendProgress(pi: ExtensionAPI, data: ProgressData): void {
  try {
    pi.appendEntry(PROGRESS_ENTRY, data);
  } catch {
    /* session replaced */
  }
}
