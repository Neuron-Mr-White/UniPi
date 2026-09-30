/**
 * @pi-unipi/utility — render-style helpers for activity that isn't a pi tool
 * call: sidekick steps, subagent transcript items. Foreign calls draw with
 * the same verbs/markers/gutter the lead's own tools get in the active style:
 *
 *   simple    `└ • Ran  npm test · 14 output lines`   (mcode row)
 *   advanced  `◆ Ran npm test` + `│ ` guttered output tail + `└ Done · 1.2s`
 *   regular   `◆ bash ls` + a few dim output lines    (pi-fallback look)
 *
 * Text (sidekick prose) renders as markdown, `● `-anchored in simple.
 */

import { getMarkdownTheme, ToolExecutionComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { getSettings } from "@pi-unipi/core";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { anchorAssistant, simpleToolLine, verbsFor } from "./simple.js";
import { readPiToolOptions } from "./pi-settings.js";

export type RenderStyle = "regular" | "advanced" | "simple";

// The style is read on every render tick (transcript entries repaint often);
// the settings file read behind getSettings is memoized briefly.
let styleCache: { at: number; cwd: string; value: RenderStyle } | undefined;

/**
 * The active transcript style (`utility.render.style`). When the utility
 * extension isn't loaded the namespace isn't registered and the style falls
 * back to pi's own look ("regular").
 */
export function renderStyle(cwd: string = process.cwd()): RenderStyle {
  const now = Date.now();
  if (styleCache !== undefined && styleCache.cwd === cwd && now - styleCache.at < 2000) return styleCache.value;
  let value: RenderStyle = "regular";
  try {
    const render = getSettings("utility", cwd).render as { style?: unknown } | undefined;
    if (render?.style === "simple" || render?.style === "advanced") value = render.style;
  } catch {
    /* unregistered namespace or unreadable settings → regular */
  }
  styleCache = { at: now, cwd, value };
  return value;
}

/** Test/evidence hook: drop the memoized style (e.g. after a settings write). */
export function resetRenderStyleCache(): void {
  styleCache = undefined;
}

/** The fg/bold subset every caller's theme object already provides. */
export type StyledTheme = Pick<Theme, "fg" | "bold">;

/** pi's duration format (renderers/bash.ts): `1.2s`, `3m 4s`, `1h 2m 3s`. */
export function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.max(1, Math.round(ms))}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

export interface StyledToolCall {
  name: string;
  /** One-line target, already picked/shrunk by the caller ("" when none). */
  arg: string;
  /** Full stored output — collapsed views show a tail, expanded all of it. */
  output: string;
  isError: boolean;
  running?: boolean;
  expanded?: boolean;
  durationMs?: number;
  /** Tree connector for the simple row (default `└`). */
  connector?: "├" | "└";
}

function outputLines(output: string): string[] {
  return output.replace(/\s+$/u, "").split("\n").filter((l, i, a) => l.length > 0 || i < a.length - 1);
}

const SIMPLE_OUTPUT_TAIL = 3;
const ADVANCED_OUTPUT_TAIL = 5;

/**
 * A foreign tool call as transcript lines in the active style. Returns []
 * when there is nothing to show.
 */
export function styledToolCallLines(
  style: RenderStyle,
  spec: StyledToolCall,
  theme: StyledTheme,
  width: number,
): string[] {
  const t = theme;
  const w = Math.max(10, width);
  const out = spec.output ? outputLines(spec.output) : [];

  if (style === "simple") {
    const metaBits: string[] = [];
    if (!spec.running) {
      if (out.length > 0) metaBits.push(`${String(out.length)} output line${out.length === 1 ? "" : "s"}`);
      if (spec.durationMs !== undefined) metaBits.push(formatElapsed(spec.durationMs));
    }
    const row = simpleToolLine(t as Theme, spec.name, spec.arg, {
      running: spec.running === true,
      failed: spec.isError,
      meta: metaBits.length > 0 ? ` · ${metaBits.join(" · ")}` : "",
      connector: spec.connector ?? "└",
      width: w,
    });
    const lines = [row];
    if (spec.expanded === true) {
      for (const l of out) lines.push(truncateToWidth(`   ${t.fg("toolOutput", l)}`, w));
    }
    return lines;
  }

  if (style === "advanced") {
    const [runningVerb, doneVerb, failedVerb] = verbsFor(spec.name);
    const verb = spec.isError ? failedVerb : spec.running === true ? runningVerb : doneVerb;
    const head = spec.arg !== ""
      ? `${t.fg("accent", "◆")} ${t.bold(verb)} ${t.fg("accent", spec.arg)}`
      : `${t.fg("accent", "◆")} ${t.bold(verb)}`;
    const lines = [truncateToWidth(head, w)];
    const shown = spec.expanded === true ? out : out.slice(-ADVANCED_OUTPUT_TAIL);
    if (spec.expanded !== true && out.length > shown.length) {
      lines.push(truncateToWidth(`${t.fg("muted", "│")} ${t.fg("dim", `… ${String(out.length - shown.length)} earlier lines (ctrl+o)`)}`, w));
    }
    for (const l of shown) lines.push(truncateToWidth(`${t.fg("muted", "│")} ${t.fg("toolOutput", l)}`, w));
    if (spec.durationMs !== undefined || spec.isError) {
      const label = spec.isError ? "Failed" : "Done";
      const dur = spec.durationMs !== undefined ? ` · ${formatElapsed(spec.durationMs)}` : "";
      lines.push(truncateToWidth(`${t.fg("muted", "└")} ${t.fg(spec.isError ? "error" : "dim", `${label}${dur}`)}`, w));
    }
    return lines;
  }

  // regular — the pi-fallback look the entry renderers used before.
  const mark = spec.isError ? t.fg("error", "✗") : t.fg("accent", "◆");
  const head = spec.arg !== ""
    ? `${mark} ${t.fg("toolTitle", t.bold(spec.name))} ${t.fg("accent", spec.arg)}`
    : `${mark} ${t.fg("toolTitle", t.bold(spec.name))}`;
  const lines = [truncateToWidth(head, w)];
  const shown = spec.expanded === true ? out : out.slice(-SIMPLE_OUTPUT_TAIL);
  if (spec.expanded !== true && out.length > shown.length) {
    lines.push(t.fg("dim", `… ${String(out.length - shown.length)} earlier lines`));
  }
  for (const l of shown) lines.push(truncateToWidth(`  ${t.fg("toolOutput", l)}`, w));
  return lines;
}

export interface StyledTextOpts {
  /** Shown dimmed above the text — only in the expanded view. */
  thinking?: string;
}

/**
 * Foreign assistant-ish text as transcript lines: markdown, `● `-anchored in
 * simple mode like the lead's prose; expanded thinking renders dimmed first.
 */
export function styledTextLines(
  style: RenderStyle,
  markdown: string,
  opts: StyledTextOpts,
  theme: StyledTheme,
  width: number,
): string[] {
  const t = theme;
  const w = Math.max(10, width);
  const lines: string[] = [];
  if (opts.thinking !== undefined && opts.thinking.trim() !== "") {
    lines.push(`${t.fg("accent", "◆")} ${t.fg("dim", "thinking")}`);
    for (const l of opts.thinking.split("\n")) {
      lines.push(truncateToWidth(`  ${t.fg("dim", l.length > 160 ? `${l.slice(0, 159)}…` : l)}`, w));
    }
  }
  const source = style === "simple" ? anchorAssistant(markdown) : markdown;
  lines.push(...new Markdown(source, 0, 0, getMarkdownTheme()).render(w));
  return lines;
}

/** Convenience wrapper: the styled lines as a pi-tui Component. */
export function styledComponent(build: (width: number) => string[]): Component {
  return { invalidate() {}, render: build };
}

// ─── regular style: pi's own finished-call card ───────────────────────────

/** pi's built-in tool factories — the defs carry the regular renderers. */
const NATIVE_FACTORIES: Record<string, (cwd: string) => object> = {
  bash: (cwd) => createBashToolDefinition(cwd, readPiToolOptions(cwd).bash),
  read: (cwd) => createReadToolDefinition(cwd, readPiToolOptions(cwd).read),
  edit: (cwd) => createEditToolDefinition(cwd) as object,
  write: (cwd) => createWriteToolDefinition(cwd) as object,
  grep: (cwd) => createGrepToolDefinition(cwd) as object,
  find: (cwd) => createFindToolDefinition(cwd) as object,
  ls: (cwd) => createLsToolDefinition(cwd) as object,
};

let nativeStepSeq = 0;

/** A stub TUI for mounted transcript components (they only re-render). */
const NATIVE_UI = { requestRender() {} };

/**
 * pi's own ToolExecutionComponent rendering a finished call — identical to
 * the lead's regular-style tool card. Available only for pi's built-in tools
 * (their renderers come from the exported def factories) and only when the
 * step carries its raw args; returns undefined otherwise (caller falls back
 * to the `◆` lines).
 */
export function nativeToolComponent(spec: {
  name: string;
  args?: Record<string, unknown>;
  output: string;
  isError: boolean;
  expanded?: boolean;
}): Component | undefined {
  const factory = NATIVE_FACTORIES[spec.name];
  if (factory === undefined || spec.args === undefined) return undefined;
  try {
    const cwd = process.cwd();
    const comp = new ToolExecutionComponent(
      spec.name,
      `foreign-step-${++nativeStepSeq}`,
      spec.args,
      {},
      factory(cwd) as never,
      NATIVE_UI as never,
      cwd,
    ) as Component & { updateResult(r: unknown, partial: boolean): void; setExpanded(b: boolean): void };
    comp.updateResult(
      { content: spec.output !== "" ? [{ type: "text", text: spec.output }] : [], isError: spec.isError },
      false,
    );
    if (spec.expanded === true) comp.setExpanded(true);
    return comp;
  } catch {
    return undefined;
  }
}
