/**
 * Hub kit — the /unipi:settings hub's visual + interaction primitives,
 * extracted so second-layer overlays can look and behave identically.
 *
 * Visual contract (the "hub look"):
 *   - frameOverlay chrome, every emitted line measured in PLAIN text at
 *     exactly `inner` visible cells (ANSI added only via targeted-off spans)
 *   - colored `▌` group mark at column 0 (namespace/package color)
 *   - header bands with background + bold+dim text
 *   - dim hint line at the bottom
 *   - relative-height viewport (~half the terminal) with `↑ N more` / `↓ N more`
 *
 * Key contract (the "hub keys"):
 *   ↑↓/jk move · Enter/Tab = activate · Space = quick · Esc = back/close
 *   / = search · PageUp/PageDown/Home/End as labeled
 */

import {
  Input,
  Key,
  matchesKey,
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
  type OverlayOptions,
} from "@earendil-works/pi-tui";
import { OverlayTheme } from "../../tui-overlay.js";
import { namespaceColor } from "../package-colors.js";

/** Shared theme instance — overlays may point it at pi's active theme. */
export const hubTheme = new OverlayTheme();

/** Point the kit's styling at pi's active theme (optional). */
export function setHubTheme(theme: Parameters<OverlayTheme["setTheme"]>[0]): void {
  hubTheme.setTheme(theme);
}

// ─── Shared overlay sizing ─────────────────────────────────────────────

/**
 * THE ctx.ui.custom options for every kit-ported overlay — the hub's own
 * included. Centered at pi's default overlay width (~80 cols) so the hub and
 * its second-layer overlays read as one family.
 */
export const HUB_OVERLAY_OPTIONS: {
  readonly overlay: true;
  readonly overlayOptions: () => OverlayOptions;
} = {
  overlay: true,
  overlayOptions: () => ({ anchor: "center" }),
};

/**
 * Wide variant for genuinely two-pane overlays (mcp add-overlay): the hub's
 * ~80-col default scaled ×1.5 = 120 columns.
 */
export const HUB_WIDE_OVERLAY_OPTIONS: {
  readonly overlay: true;
  readonly overlayOptions: () => OverlayOptions;
} = {
  overlay: true,
  overlayOptions: () => ({ anchor: "center", width: 120, minWidth: 100 }),
};

const hubDim = (t: string): string => hubTheme.fg("textMuted", t);
const hubBold = (t: string): string => hubTheme.bold(t);

/** Styled dim text (theme-aware) — for spans outside the kit's rows. */
export const hubDimText = hubDim;
/** Styled bold text (theme-aware) — for spans outside the kit's rows. */
export const hubBoldText = hubBold;

// ─── Key classifier ──────────────────────────────────────────────────────

export type HubKey =
  | "up"
  | "down"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "activate" // Enter or Tab
  | "quick" // Space
  | "back" // Esc
  | "search" // /
  | "other"
  | { readonly char: string };

/**
 * Classify one keypress. `j`/`k` count as down/up (hub list semantics) —
 * callers with a TEXT field (search, searchable pickers) must check the
 * text-special keys first and route raw data to the Input instead.
 */
export function hubKey(data: string): HubKey {
  const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
  if (matchesKey(data, Key.up) || ch === "k") return "up";
  if (matchesKey(data, Key.down) || ch === "j") return "down";
  if (matchesKey(data, Key.pageUp)) return "pageUp";
  if (matchesKey(data, Key.pageDown)) return "pageDown";
  if (matchesKey(data, Key.home)) return "home";
  if (matchesKey(data, Key.end)) return "end";
  if (matchesKey(data, Key.escape) || data === "\x1b") return "back";
  if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || data === "\r" || data === "\n") return "activate";
  if (matchesKey(data, Key.space) || data === " ") return "quick";
  if (matchesKey(data, Key.slash) || ch === "/") return "search";
  if (ch !== undefined) return { char: ch };
  return "other";
}

// ─── Width-exact rows ────────────────────────────────────────────────────

/** Truncate/pad styled or plain content to exactly `inner` visible cells. */
export function hubExactRow(content: string, inner: number): string {
  const w = visibleWidth(content);
  if (w === inner) return content;
  if (w > inner) return truncateToWidth(content, Math.max(0, inner), "");
  return content + " ".repeat(inner - w);
}

/** Plain-text group-mark cell: `▌` for colored namespaces, else a space. */
export function hubMarkChar(namespace: string | undefined): string {
  return namespaceColor(namespace ?? "") ? "▌" : " ";
}

/**
 * Styled `▌` group mark — bold + the namespace's ANSI color. Closes with
 * targeted-off codes ([22m[39m), never [0m: a full reset mid-line would kill
 * an enclosing background paint.
 */
export function hubMarkSpan(namespace: string | undefined): string {
  const color = namespaceColor(namespace ?? "");
  return color ? `${color}${hubBold("▌")}\x1b[39m` : " ";
}

export interface HubRowOptions {
  readonly inner: number;
  /** 2-cell cursor: `› ` when selected, `  ` otherwise. */
  readonly selected: boolean;
  readonly label: string;
  readonly value: string;
  /** Namespace (or package key) for the colored ▌ mark. */
  readonly markNamespace?: string;
}

/**
 * Two-column row (label left, value right): cursor + group mark + label +
 * flexible gap + value, with one trailing cell of air. Exactly `inner` cells.
 */
export function hubRowColumns(opts: HubRowOptions): string {
  const { inner, selected, label, value, markNamespace } = opts;
  const cursor = selected ? "› " : "  ";
  const valW = visibleWidth(value);
  // Cursor + group mark eat 4 cells before the label.
  const room = Math.max(0, inner - 4 - valW - 2);
  const labelT = truncateToWidth(label, room, "…");
  const gap = Math.max(1, inner - 4 - visibleWidth(labelT) - valW - 1);
  const mark = markNamespace ? `${hubMarkSpan(markNamespace)} ` : "  ";
  const labelStyled = selected ? hubBold(labelT) : labelT;
  const valueStyled = selected ? hubBold(value) : hubDim(value);
  return `${cursor}${mark}${labelStyled}${" ".repeat(gap)}${valueStyled}`;
}

export interface HubBandOptions {
  readonly inner: number;
  readonly text: string;
  /** Namespace/package key for the ▌ mark at column 0. */
  readonly namespace?: string;
}

/** Full-width header band: bg + ▌ at column 0, dim+bold remainder. */
export function hubHeaderBand(opts: HubBandOptions): string {
  const { inner, text, namespace } = opts;
  const plain = hubExactRow(`${hubMarkChar(namespace)} ${text}`, inner);
  const color = namespaceColor(namespace ?? "");
  const painted = color
    ? hubMarkSpan(namespace) + hubDim(hubBold(plain.slice(1)))
    : hubDim(hubBold(plain));
  return hubTheme.bg("customMessageBg", painted);
}

/** Dim bottom hint line, padded to exactly `inner` cells. */
export function hubHintLine(text: string, inner: number): string {
  return hubExactRow(hubDim(`  ${text}`), inner);
}

// ─── Viewport (relative height + scroll) ─────────────────────────────────

/**
 * Visible rows for the current scroll: `maxRows = max(3, min(term/2, term-7)
 * - reserve)` — a dialog, not a takeover.
 */
export function hubMaxRows(terminalRows: number, overlayReserve = 0): number {
  return Math.max(3, Math.min(Math.floor(terminalRows / 2), terminalRows - 7) - overlayReserve);
}

/**
 * Clamp scroll to the cursor, KEEPING the contiguous header run directly
 * above it visible (scroll lands on the first header of that run; 0 when no
 * selectable row precedes the cursor). Bottom clamp unchanged — trailing rows
 * are selectable.
 */
export function hubClampScroll(
  kinds: readonly string[],
  cursor: number,
  scroll: number,
  maxRows: number,
): number {
  let next = scroll;
  if (cursor < next) {
    let start = cursor;
    while (start > 0 && kinds[start - 1] === "header") start--;
    next = start;
  }
  if (cursor > next + maxRows - 1) next = cursor - maxRows + 1;
  return Math.max(0, Math.min(next, Math.max(0, kinds.length - maxRows)));
}

/** `↑ N more` top scroll indicator. */
export function hubMoreAbove(hidden: number, inner: number): string {
  return hubExactRow(hubDim(`  ↑ ${hidden} more`), inner);
}

/** `↓ N more` bottom scroll indicator. */
export function hubMoreBelow(hidden: number, inner: number): string {
  return hubExactRow(hubDim(`  ↓ ${hidden} more`), inner);
}

// ─── Search ──────────────────────────────────────────────────────────────

export type HubSearchEvent = "applied" | "exited" | "typing";

/**
 * Hub search: `/` opens it, typing filters live, Enter applies, and Esc OR
 * Backspace-on-empty exits (exactly like Esc).
 */
export class HubSearch {
  readonly input: Input;
  filter = "";

  constructor(prompt = "/") {
    this.input = new Input({ prompt });
  }

  getValue(): string {
    return this.input.getValue();
  }

  /** Backspace on an EMPTY input exits search exactly like Esc. */
  isExitKey(data: string): boolean {
    return (
      matchesKey(data, Key.escape) ||
      data === "\x1b" ||
      ((matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") &&
        this.input.getValue() === "")
    );
  }

  /**
   * Feed one keypress while search is open. "applied" → caller takes
   * `filter` and returns to the list; "exited" → drop the search;
   * "typing" → filter is live-updated.
   */
  handle(data: string): HubSearchEvent {
    if (this.isExitKey(data)) {
      this.filter = "";
      return "exited";
    }
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      this.filter = this.input.getValue();
      return "applied";
    }
    this.input.handleInput(data);
    this.filter = this.input.getValue(); // live filtering
    return "typing";
  }
}

// ─── Frame title ─────────────────────────────────────────────────────────

/** ` <base> › <crumb> › <crumb> <tail> ` — e.g. ` unipi settings › serpapi — global [g] `. */
export function hubFrameTitle(base: string, crumbs: readonly string[], tail = ""): string {
  const parts = [base, ...crumbs].join(" › ");
  return ` ${parts}${tail ? ` ${tail}` : ""} `;
}
