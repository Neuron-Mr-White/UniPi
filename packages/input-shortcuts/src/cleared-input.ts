/**
 * Ctrl+C keeps what it cleared (Devin-style):
 *   - the text stays in the transcript, struck through (UI-only entry — custom
 *     entries never reach the model, so no tokens and no prefix-cache churn);
 *   - it is pushed onto the editor's ↑ history, so ↑ brings it back.
 *
 * pi still does the clearing (and double Ctrl+C still exits). We only look at
 * the key first via onTerminalInput and never consume it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { KitTheme } from "@pi-unipi/core";

export const CLEARED_ENTRY = "unipi-cleared-input";
const PROBE_WIDGET = "unipi-cleared-input-probe";
const MAX_LINES = 3;

interface EditorLike {
  getText(): string;
  addToHistory(text: string): void;
}

function isEditor(c: unknown): c is EditorLike {
  const e = c as Partial<EditorLike> | null | undefined;
  return typeof e?.getText === "function" && typeof e.addToHistory === "function";
}

const strike = (s: string) => `\x1b[9m${s}\x1b[29m`;

/** `⌫ ~~fix the flaky test~~  ↑ restores` (+ up to two more struck lines). */
export function clearedLines(t: KitTheme, text: string, width: number): string[] {
  const all = text.replace(/\s+$/u, "").split("\n");
  const shown = all.slice(0, MAX_LINES);
  const out = shown.map((l, i) => truncateToWidth(`${i === 0 ? t.fg("dim", "⌫ ") : "  "}${t.fg("dim", strike(l))}`, width));
  if (all.length > shown.length) out.push(t.fg("dim", `  … ${String(all.length - shown.length)} more line${all.length - shown.length === 1 ? "" : "s"}`));
  out[0] = truncateToWidth(`${out[0]!}${t.fg("dim", "  ↑ restores")}`, width);
  return out;
}

/**
 * Decide what to record for a key press. Returns the text to keep, or
 * undefined when the key isn't Ctrl+C / the focus isn't a non-empty editor.
 */
export function clearedText(data: string, focused: unknown): string | undefined {
  if (!matchesKey(data, "ctrl+c") || !isEditor(focused)) return undefined;
  const text = focused.getText();
  return text.trim() ? text : undefined;
}

export function installClearedInput(pi: ExtensionAPI): void {
  let tui: TUI | undefined;
  let unsub: (() => void) | undefined;

  try {
    pi.registerEntryRenderer<{ text: string }>(CLEARED_ENTRY, (entry, _opts, theme): Component | undefined => {
      const text = entry.data?.text;
      if (!text) return undefined;
      return { invalidate() {}, render: (w: number) => clearedLines(theme as KitTheme, text, w) };
    });
  } catch {
    /* UI-dependent */
  }

  pi.on("session_start", (_e, ctx: ExtensionContext) => {
    unsub?.();
    unsub = undefined;
    if (!ctx.hasUI) return;
    try {
      // An empty widget, only to get hold of the TUI (for the focused editor).
      ctx.ui.setWidget(PROBE_WIDGET, (t) => {
        tui = t;
        return { invalidate() {}, render: () => [] };
      }, { placement: "belowEditor" });
      unsub = ctx.ui.onTerminalInput((data) => {
        try {
          const focused = (tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.();
          const text = clearedText(data, focused);
          if (text === undefined) return undefined;
          (focused as EditorLike).addToHistory(text);
          pi.appendEntry(CLEARED_ENTRY, { text });
        } catch {
          /* never block the key */
        }
        return undefined;
      });
    } catch {
      /* UI-dependent */
    }
  });

  pi.on("session_shutdown", () => {
    unsub?.();
    unsub = undefined;
    tui = undefined;
  });
}
