/**
 * @pi-unipi/utility — "simple" style: the final reply gets a soft background.
 *
 * In a long transcript of collapsed tool rows the actual answer is easy to
 * miss. An assistant message with no tool calls (the turn's reply) is painted
 * on the darkest possible panel (true black), introduced by a thin divider
 * line labelled "summary". On light themes the text is lifted to bright white
 * so it stays readable on the black panel.
 *
 * pi has no hook for assistant-message rendering, and extensions get a
 * different module instance of AssistantMessageComponent than the one pi
 * renders, so the class is found in the live TUI tree (duck-typed) and its
 * render is wrapped once. Output is cached per component by width + message +
 * colour, so a keystroke re-render is a lookup, not a repaint.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

const PROBE_WIDGET = "unipi-reply-bg-probe";
const PATCHED = Symbol.for("unipi.replyBg.patched");

interface AssistantLike {
  hasToolCalls: boolean;
  isStreaming: boolean;
  lastMessage?: unknown;
  contentContainer: unknown;
  updateContent: (...args: unknown[]) => void;
  render: (width: number) => string[];
}

interface TreeNode {
  children?: unknown[];
}

function isAssistant(c: unknown): c is AssistantLike {
  const a = c as Partial<AssistantLike> | null;
  return !!a && typeof a === "object" && "contentContainer" in a && "hasToolCalls" in a && typeof a.updateContent === "function";
}

/** Depth-first search of the TUI tree for pi's assistant message component. */
export function findAssistant(root: unknown, depth = 0): AssistantLike | undefined {
  if (!root || typeof root !== "object" || depth > 12) return undefined;
  if (isAssistant(root)) return root;
  for (const child of (root as TreeNode).children ?? []) {
    const hit = findAssistant(child, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Relative luminance 0..1 of an ANSI background escape (truecolor or 256). */
export function bgLuminance(ansi: string): number | undefined {
  const tc = /48;2;(\d+);(\d+);(\d+)/.exec(ansi);
  if (tc) return (0.2126 * +tc[1]! + 0.7152 * +tc[2]! + 0.0722 * +tc[3]!) / 255;
  const c256 = /48;5;(\d+)/.exec(ansi);
  if (c256) {
    const n = +c256[1]!;
    if (n >= 232) return (8 + (n - 232) * 10) / 255;
    if (n >= 16) {
      const i = n - 16;
      const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
      return (0.2126 * v(Math.floor(i / 36)) + 0.7152 * v(Math.floor(i / 6) % 6) + 0.0722 * v(i % 6)) / 255;
    }
  }
  return undefined;
}

/** The reply background: the darkest possible (true black). */
export function replyBg(_theme?: unknown): string {
  return "\x1b[48;2;0;0;0m";
}

/** Bright white fg re-opened after resets when the theme is light (black panel). */
export function replyFg(theme: { getBgAnsi?: (k: string) => string } | undefined): string | null {
  try {
    const lum = bgLuminance(theme?.getBgAnsi?.("userMessageBg") ?? "");
    return lum !== undefined && lum > 0.5 ? "\x1b[97m" : null;
  } catch {
    return null;
  }
}

/** The divider introducing the panel: "─ summary ─────…". */
export function dividerLine(theme: { fg?: (k: string, t: string) => string } | undefined, label: string, width: number): string {
  const dash = (n: number) => "─".repeat(Math.max(0, n));
  const text = ` ${label} `;
  const line = `\u2500${text}${dash(width - 1 - visibleWidth(text))}`;
  const fg = (t: string) => {
    try {
      return theme?.fg?.("borderMuted", t) ?? `\x1b[90m${t}\x1b[39m`;
    } catch {
      return `\x1b[90m${t}\x1b[39m`;
    }
  };
  // truncate by visible width; the theme wrapper is zero-width
  const visible = line.length;
  return visible <= width ? fg(line) : fg(line.slice(0, Math.max(0, width)));
}

/**
 * Paint one line on `bg`, padded to `width`. Inner resets (`\x1b[0m`,
 * `\x1b[49m`) would end the background mid-line, so the background is
 * re-opened right after each of them.
 */
export function paintLine(line: string, width: number, bg: string, fg: string | null = null): string {
  const pad = Math.max(0, width - visibleWidth(line));
  const reopen = (m: string) => m + bg + (fg ?? "");
  const body = line.replace(/\x1b\[(?:0|39|49)m/g, reopen);
  return `${bg}${fg ?? ""}${body}${" ".repeat(pad)}\x1b[49m${fg ? "\x1b[39m" : ""}`;
}

/** A step with no visible text (thinking and/or tool calls only) that ended normally. */
export function isBlankStep(msg: unknown): boolean {
  const m = msg as { content?: unknown; stopReason?: string } | undefined;
  if (!m || !Array.isArray(m.content)) return false;
  if (m.stopReason === "error" || m.stopReason === "aborted" || m.stopReason === "length") return false;
  return !m.content.some((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.trim());
}

/**
 * Wrap the component class's render once. `getBg` is read per render so a
 * theme switch takes effect; `enabled` lets the caller turn it off.
 */
export function patchAssistantRender(
  proto: AssistantLike,
  getPanel: () => { bg: string; fg: string | null; dividerFor: (width: number) => string },
): void {
  const p = proto as unknown as Record<PropertyKey, unknown>;
  if (p[PATCHED]) return;
  const original = proto.render;
  const cache = new WeakMap<object, { width: number; msg: unknown; bg: string; streaming: boolean; lines: string[] }>();
  proto.render = function (this: AssistantLike, width: number): string[] {
    // Simple mode hides thinking, but pi still adds a leading Spacer for a
    // thinking-only step (and a hidden label line), so every tool step left
    // blank rows — a growing gap above tool groups. No visible text → no rows.
    if (isBlankStep(this.lastMessage)) return [];
    const lines = original.call(this, width);
    // Only the reply: finished, no tool calls, something visible.
    if (this.hasToolCalls || this.isStreaming || lines.length === 0) return lines;
    const { bg, fg, dividerFor } = getPanel();
    const hit = cache.get(this);
    if (hit && hit.width === width && hit.msg === this.lastMessage && hit.bg === bg && hit.streaming === this.isStreaming) return hit.lines;
    const painted = [dividerFor(width), ...lines.map((l) => paintLine(l, width, bg, fg))];
    // A bottom pad row so the panel doesn't end flush on the last text line.
    painted.push(paintLine("", width, bg));
    cache.set(this, { width, msg: this.lastMessage, bg, streaming: this.isStreaming, lines: painted });
    return painted;
  };
  p[PATCHED] = true;
}

/**
 * Install for the session: grab the TUI via an empty widget, and after each
 * agent turn look for an assistant component until one is found and patched.
 */
export function installReplyBackground(pi: {
  on: (event: any, handler: (event: any, ctx?: any) => void) => void;
}): void {
  let tui: unknown;
  let theme: any;
  let done = false;
  const tryPatch = () => {
    if (done || !tui) return;
    const hit = findAssistant(tui);
    if (!hit) return;
    patchAssistantRender(Object.getPrototypeOf(hit) as AssistantLike, () => ({
      bg: replyBg(),
      fg: replyFg(theme),
      dividerFor: (width: number) => dividerLine(theme, "summary", width),
    }));
    done = true;
    try {
      (tui as { requestRender?: (force?: boolean) => void }).requestRender?.(true);
    } catch {}
  };
  try {
    pi.on("session_start", (_e: any, ctx: any) => {
      if (!ctx?.hasUI) return;
      try {
        ctx.ui.setWidget(
          PROBE_WIDGET,
          (t: unknown, th: unknown) => {
            tui = t;
            theme = th;
            return { invalidate() {}, render: () => [] };
          },
          { placement: "belowEditor" },
        );
        // Resumed sessions already have replies on screen.
        setTimeout(tryPatch, 0);
      } catch {}
    });
    pi.on("message_start", () => setTimeout(tryPatch, 0));
    pi.on("message_end", () => setTimeout(tryPatch, 0));
    pi.on("agent_end", () => setTimeout(tryPatch, 0));
  } catch {
    // cosmetic; never block load
  }
}
