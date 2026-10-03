/**
 * @pi-unipi/utility — "simple" style: the final reply gets a soft background.
 *
 * In a long transcript of collapsed tool rows the actual answer is easy to
 * miss. An assistant message with no tool calls (the turn's reply) is painted
 * on the darkest possible panel (true black), framed by an orange heavy rule
 * labelled "summary" above and a matching unlabelled rule below, with one blank
 * row of breathing space before the top rule. On light themes the text is lifted to
 * bright white so it stays readable on the black panel.
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

export function isAssistant(c: unknown): c is AssistantLike {
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

/** The rule colour: orange, truecolor on capable terminals, 256-colour fallback. */
export function ruleFg(theme: { getColorMode?: () => string } | undefined): string {
  let mode = "truecolor";
  try {
    mode = theme?.getColorMode?.() ?? "truecolor";
  } catch {}
  return mode === "truecolor" ? "\x1b[38;2;255;135;0m" : "\x1b[38;5;208m";
}

/**
 * The heavy rule that frames the panel. With a label the word sits centred
 * between two runs of rule ("━━━━━ summary ━━━━━"); without one the rule
 * spans the full width (the closing edge under the panel). Painted in orange
 * with a bold label.
 */
export function dividerLine(
  theme: { getColorMode?: () => string; bold?: (t: string) => string } | undefined,
  label: string,
  width: number,
): string {
  const w = Math.max(0, width);
  const rule = "━";
  const color = (t: string) => `${ruleFg(theme)}${t}\x1b[39m`;
  const bold = (t: string) => {
    try {
      return theme?.bold?.(t) ?? `\x1b[1m${t}\x1b[22m`;
    } catch {
      return `\x1b[1m${t}\x1b[22m`;
    }
  };
  if (!label) return color(rule.repeat(w));
  const text = ` ${label} `;
  const inner = visibleWidth(text);
  if (inner >= w) return color(text.slice(0, w));
  const left = Math.floor((w - inner) / 2);
  return color(rule.repeat(left)) + bold(color(text)) + color(rule.repeat(w - inner - left));
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

/** A rendered row that paints nothing: whitespace + SGR/OSC sequences only. */
const OSC_SEQ = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SGR_SEQ = /\x1b\[[0-9;]*m/g;

function isImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

export function isBlankRendered(line: string): boolean {
  if (isImageLine(line)) return false;
  return line.replace(OSC_SEQ, "").replace(SGR_SEQ, "").trim() === "";
}

/**
 * Drop rendered blank rows at both edges of a component's output. pi parks a
 * Spacer(1) as the first child of every content-bearing assistant message —
 * rendered, it's a stray blank row below custom badges and above mid-turn
 * text, and a pad row under the summary rule inside the reply panel. Dropped
 * edge lines keep their OSC-133 zone markers (pi prepends `\x1b]133;A\x07` to
 * the first line of a tool-free message): they're moved onto the surviving
 * edge lines so prompt-zone navigation isn't lost.
 */
export function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  let firstNonBlank = -1;
  let lastImageIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (firstNonBlank === -1 && !isBlankRendered(l)) {
      firstNonBlank = i;
    }
    if (isImageLine(l)) {
      lastImageIndex = i;
    }
  }

  // Never trim leading blanks if the first non-blank line is an image line (iTerm2 layout).
  const skipLeadingTrim = firstNonBlank !== -1 && isImageLine(lines[firstNonBlank]!);
  if (!skipLeadingTrim) {
    while (start < end && isBlankRendered(lines[start]!)) start++;
  }

  // Never trim trailing blanks that come after the last image line (Kitty layout).
  const trailingBlanksAfterImage = lastImageIndex !== -1 && lines.slice(lastImageIndex + 1).every(isBlankRendered);
  if (!trailingBlanksAfterImage) {
    while (end > start && isBlankRendered(lines[end - 1]!)) end--;
  }

  const kept = lines.slice(start, end);
  if (kept.length === 0) return kept;
  const zones = (ls: string[]) => ls.join("").match(OSC_SEQ)?.join("") ?? "";
  // Tail first, then head: a single surviving line ends up head+tail+text,
  // matching pi's A…B C order (zone start precedes zone end).
  const tail = zones(lines.slice(end));
  if (tail) kept[kept.length - 1] = tail + kept[kept.length - 1];
  const head = zones(lines.slice(0, start));
  if (head) kept[0] = head + kept[0];
  return kept;
}

/**
 * Drop children of a message's content container that render only blank rows.
 * In simple mode that's each hidden-thinking run: pi wraps the label Text in a
 * MouseRegion, and theme.italic(theme.fg(key, "")) is ANSI escapes around an
 * empty string — it survives Text's empty check (`trim()` keeps escapes) and
 * paints a full blank row — plus the Spacer pi parks after a thinking run. A
 * thinking+text step would otherwise show ~3 blank rows above the text. A
 * region with real content (non-empty label) is kept.
 */
export function stripBlankRuns(container: unknown, width: number): void {
  const kids = (container as TreeNode | undefined)?.children;
  if (!Array.isArray(kids)) return;
  const blank = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
  for (let i = kids.length - 1; i >= 0; i--) {
    const child = kids[i] as { child?: unknown; render?: (w: number) => string[] } | null;
    if (!child || typeof child !== "object" || !("child" in child) || typeof child.render !== "function") continue;
    let empty = false;
    try {
      empty = child.render(width).every(blank);
    } catch {}
    if (!empty) continue;
    kids.splice(i, 1);
    const next = kids[i] as { lines?: unknown } | null | undefined;
    if (next && typeof next === "object" && typeof next.lines === "number") kids.splice(i, 1);
  }
}

/**
 * Wrap the component class's render once. `getBg` is read per render so a
 * theme switch takes effect; `enabled` lets the caller turn it off.
 */
export function patchAssistantRender(
  proto: AssistantLike,
  getPanel: () => { bg: string; fg: string | null; dividerFor: (width: number, label?: string) => string },
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
    stripBlankRuns(this.contentContainer, width);
    const lines = trimEdgeBlankLines(original.call(this, width));
    // Only the reply: finished, no tool calls, something visible — and the
    // message must have ended cleanly. An error/abort/length/deferred tail
    // isn't the turn's reply and doesn't get the summary frame.
    if (this.hasToolCalls || this.isStreaming || lines.length === 0) return lines;
    const stop = (this.lastMessage as { stopReason?: string } | undefined)?.stopReason;
    if (stop === "pending" || stop === "error" || stop === "aborted" || stop === "length" || stop === "deferred") return lines;
    const { bg, fg, dividerFor } = getPanel();
    const hit = cache.get(this);
    if (hit && hit.width === width && hit.msg === this.lastMessage && hit.bg === bg && hit.streaming === this.isStreaming) return hit.lines;
    const painted = [
      "", // breathing space above the section rule
      dividerFor(width),
      // Exactly one pad row below the rule, mirroring the bottom pad: the
      // reply (its `●` anchor) starts one blank row under "─ summary ─" —
      // never flush, never two.
      paintLine("", width, bg),
      ...lines.map((l) => paintLine(l, width, bg, fg)),
      // A bottom pad row so the panel doesn't end flush on the last text line.
      paintLine("", width, bg),
      dividerFor(width, ""), // closing edge under the panel
    ];
    cache.set(this, { width, msg: this.lastMessage, bg, streaming: this.isStreaming, lines: painted });
    return painted;
  };
  p[PATCHED] = true;
}

/**
 * Install for the session: grab the TUI via an empty widget, and after each
 * agent turn look for an assistant component until one is found and patched.
 * `onTick` runs on every attempt once the TUI is known — it gets the tree root,
 * which the simple renderer uses to reconcile tool-call grouping after a
 * resumed-session history render (replay fires no message_* events, so the
 * event-driven group breaks never happen and every call lands in one group).
 */
export function installReplyBackground(pi: {
  on: (event: any, handler: (event: any, ctx?: any) => void) => void;
}, onTick?: (tui: unknown) => void): void {
  let tui: unknown;
  let theme: any;
  let done = false;
  const tryPatch = () => {
    if (tui) {
      try {
        onTick?.(tui);
      } catch {}
    }
    if (done || !tui) return;
    const hit = findAssistant(tui);
    if (!hit) return;
    patchAssistantRender(Object.getPrototypeOf(hit) as AssistantLike, () => ({
      bg: replyBg(),
      fg: replyFg(theme),
      dividerFor: (width: number, label = "summary") => dividerLine(theme, label, width),
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
        // Resumed sessions already have replies on screen; history renders
        // right after extension init, so probe a few times until the tree is
        // populated even if the user never sends another message.
        for (const ms of [0, 400, 2000]) setTimeout(tryPatch, ms);
      } catch {}
    });
    pi.on("message_start", () => setTimeout(tryPatch, 0));
    pi.on("message_end", () => setTimeout(tryPatch, 0));
    pi.on("agent_end", () => setTimeout(tryPatch, 0));
  } catch {
    // cosmetic; never block load
  }
}
