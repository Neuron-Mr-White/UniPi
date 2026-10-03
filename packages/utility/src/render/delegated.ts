/**
 * @pi-unipi/utility — the approved UNI-2 "delegated work" panel: one outer
 * dark-cyan fill (#12363b) with a bright cyan ▏ rail (#22d3ee) on every row
 * (blank interior rows included), replacing today's nested per-card
 * backgrounds. Rendered content comes from the shared style helpers
 * (styledToolCallLines / styledTextLines / nativeToolComponent for regular
 * raw-args); every nested background SGR is stripped atomically before the
 * single outer fill is applied, so foreground colours (native card fg, syntax,
 * markdown semantics) survive untouched.
 *
 * The returned component carries spacingGroup metadata so adjacent steps join
 * into one continuous panel (spacing.ts resolves it through the host's
 * CustomEntryComponent.customComponent wrapper).
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { nativeToolComponent, renderStyle, styledTextLines, styledToolCallLines, type RenderStyle, type StyledTheme } from "./styled.js";
import { paintLine, trimEdgeBlankLines } from "./reply-bg.js";
import type { SpacingGroupPosition } from "./spacing.js";

/** Minimal single-width component; the cache key (e.g. active render style)
 *  invalidates without host help, `invalidate()` clears unconditionally. */
function styledComponentLike(build: (width: number) => string[], cacheKey: (width: number) => string = () => ""): Component & Record<PropertyKey, unknown> {
  let cache: { width: number; key: string; lines: string[] } | undefined;
  return {
    invalidate(): void {
      cache = undefined;
    },
    render(width: number): string[] {
      const key = cacheKey(width);
      if (cache === undefined || cache.width !== width || cache.key !== key) cache = { width, key, lines: build(width) };
      return cache.lines;
    },
  } as Component & Record<PropertyKey, unknown>;
}

/** A SidekickStep-compatible step (structural, fusion/subagent agnostic). */
export type DelegatedStep =
  | { kind: "tool"; name: string; arg: string; output: string; isError: boolean; durationMs: number; args?: Record<string, unknown> }
  | { kind: "text"; text: string; thinking?: string };

export interface DelegatedIdentity {
  /** spacingGroup for the panel run — unique per agent/handoff. */
  group: string;
  /** Panel header, drawn once on the first group position (index 0). */
  label?: string;
  /** Render style override; defaults to the active utility render style. */
  style?: RenderStyle;
}

// ── approved palette (truecolor, 256-colour fallback) ──────────────────────
export const DELEGATED_PANEL_HEX = "#12363b";
export const DELEGATED_RAIL_HEX = "#22d3ee";
const RAIL = "▏ ";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const c = hex.replace("#", "");
  return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16) };
}

function hexTo256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  // Weighted RGB distance (perceptual weights), mirroring pi's own converter:
  // nearest 6×6×6-cube cell vs nearest grayscale ramp entry, closer wins.
  const dist = (r2: number, g2: number, b2: number) => 0.299 * (r - r2) ** 2 + 0.587 * (g - g2) ** 2 + 0.114 * (b - b2) ** 2;
  const cube = [0, 95, 135, 175, 215, 255];
  const nearest = (v: number) => cube.reduce((best, x) => (Math.abs(v - x) < Math.abs(v - best) ? x : best), cube[0]!);
  const ri = cube.indexOf(nearest(r)), gi = cube.indexOf(nearest(g)), bi = cube.indexOf(nearest(b));
  const cubeIndex = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = dist(cube[ri]!, cube[gi]!, cube[bi]!);
  const gray = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
  let grayBest = 0;
  for (let i = 1; i < gray.length; i++) if (dist(gray[i]!, gray[i]!, gray[i]!) < dist(gray[grayBest]!, gray[grayBest]!, gray[grayBest]!)) grayBest = i;
  const grayIndex = 232 + grayBest;
  const grayDist = dist(gray[grayBest]!, gray[grayBest]!, gray[grayBest]!);
  return cubeDist <= grayDist ? cubeIndex : grayIndex;
}

type ColorMode = "truecolor" | "256color";
function modeOf(theme: { getColorMode?: () => ColorMode } | undefined): ColorMode {
  try {
    return theme?.getColorMode?.() ?? "truecolor";
  } catch {
    return "truecolor";
  }
}

function fgAnsi(hex: string, mode: ColorMode): string {
  if (mode === "256color") return `\x1b[38;5;${String(hexTo256(hex))}m`;
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;
}
function bgAnsi(hex: string, mode: ColorMode): string {
  if (mode === "256color") return `\x1b[48;5;${String(hexTo256(hex))}m`;
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[48;2;${String(r)};${String(g)};${String(b)}m`;
}

/** The panel fill (dark cyan) in the theme's colour mode. */
export function delegatedPanelBg(theme?: { getColorMode?: () => ColorMode }): string {
  return bgAnsi(DELEGATED_PANEL_HEX, modeOf(theme));
}
/** The rail colour (bright cyan) in the theme's colour mode. */
export function delegatedRailFg(theme?: { getColorMode?: () => ColorMode }): string {
  return fgAnsi(DELEGATED_RAIL_HEX, modeOf(theme));
}

/**
 * Strip every nested background SGR from a rendered line — truecolor, 256 and
 * 8-colour backgrounds plus bg resets — while preserving foreground. Extended
 * sequences (38;2;r;g;b / 38;5;n) are consumed atomically so their colour
 * components can't be mistaken for background params.
 */
export function stripNestedBackgrounds(line: string): string {
  return line.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
    if (params === "") return "\x1b[0m";
    const parts = params.split(";");
    const keep: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i] || "0");
      if (n === 38 || n === 48) {
        const sub = Number(parts[i + 1]);
        const span = sub === 2 ? 5 : sub === 5 ? 3 : 1;
        const atom = parts.slice(i, i + span).join(";");
        i += span - 1;
        if (n === 38) keep.push(atom);
        continue;
      }
      if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) continue;
      keep.push(parts[i]!);
    }
    return keep.length > 0 ? `\x1b[${keep.join(";")}m` : "";
  });
}

/**
 * One rail-painted panel row: cyan ▏ + content on the single outer fill,
 * padded to `width` — blank interior rows get the same treatment, so a panel
 * is continuous with no unpainted gaps. Content backgrounds are stripped.
 */
export function paintDelegatedLine(line: string, width: number, theme?: { getColorMode?: () => ColorMode }): string {
  const w = Math.max(1, Math.trunc(width) || 1);
  const painted = paintLine(
    `${delegatedRailFg(theme)}${RAIL}\x1b[39m${stripNestedBackgrounds(line)}`,
    w,
    delegatedPanelBg(theme),
  );
  return truncateToWidth(painted, w);
}

/**
 * Semantic fg overrides for delegated panels: cyan accents/titles/results,
 * neutral light output/text, fixed muted metadata and red errors — the user's
 * global theme is never modified. Markdown semantic colours are untouched
 * (they come from the global markdown theme); only these keys are remapped.
 */
export function delegatedTheme(theme: StyledTheme, mode: ColorMode = "truecolor"): StyledTheme {
  const overrides = new Map<string, string>([
    ["accent", fgAnsi(DELEGATED_RAIL_HEX, mode)],
    ["success", fgAnsi(DELEGATED_RAIL_HEX, mode)],
    ["toolTitle", fgAnsi(DELEGATED_RAIL_HEX, mode)],
    ["toolOutput", fgAnsi("#e8f4f4", mode)],
    ["text", fgAnsi("#e8f4f4", mode)],
    ["error", fgAnsi("#ff6b6b", mode)],
    ["muted", fgAnsi("#86b0b5", mode)],
    ["dim", fgAnsi("#5f8a8f", mode)],
    ["borderMuted", fgAnsi("#5f8a8f", mode)],
  ]);
  return {
    fg(color: string, text: string): string {
      const ansi = overrides.get(color);
      return ansi !== undefined ? `${ansi}${text}\x1b[39m` : theme.fg(color as never, text);
    },
    bold: (t: string) => theme.bold(t),
  } as StyledTheme;
}

// ── the step renderer ──────────────────────────────────────────────────────

/** Test seam: how many times the native component factory actually ran. */
export const nativeFactoryStats = { calls: 0 };

/** Raw native rows for a regular-style step with raw args. The component is
 *  cached per (width, expanded, output, error) — the host's rebuild supplies a
 *  fresh inner component (and theme) anyway, so within one inner lifetime a
 *  repeated render at the same key reuses the native instance instead of
 *  re-running the factory. */
function makeNativeCache() {
  let comp: Component | undefined;
  let key = "";
  return (step: DelegatedStep & { kind: "tool" }, expanded: boolean, inner: number): string[] | undefined => {
    if (step.args === undefined) return undefined;
    const k = `${String(inner)}|${String(expanded)}|${String(step.isError)}|${String(step.output.length)}`;
    if (comp === undefined || key !== k) {
      key = k;
      try {
        nativeFactoryStats.calls++;
        comp = nativeToolComponent({
          name: step.name,
          args: step.args,
          output: step.output,
          isError: step.isError,
          expanded,
        }) ?? undefined;
      } catch {
        comp = undefined;
      }
    }
    if (comp === undefined) return undefined;
    try {
      return trimEdgeBlankLines(comp.render(inner));
    } catch {
      return undefined;
    }
  };
}

/**
 * One delegated step as a transcript component in the approved panel design.
 * The component carries `spacingGroup`/`spacingKind`/`setGroupPosition` so
 * spacing.ts can join adjacent members of the same group into one continuous
 * panel: connectors `├` while another tool step follows in the run, `└` on the
 * last; the `label` (when given) is drawn only on group position 0. A fresh
 * native component is cached per inner component instance (keyed by width,
 * expansion, error and output length), so repeated renders reuse it while a
 * theme/expansion rebuild — which creates a fresh inner component — never sees
 * stale state.
 */
/** Theme colour mode, read from the passed theme when it exposes one. */
type ModeTheme = StyledTheme & { getColorMode?: () => "truecolor" | "256color" };

export function renderDelegatedStep(step: DelegatedStep, expanded: boolean, theme: StyledTheme, options: DelegatedIdentity): Component & {
  spacingGroup: string;
  spacingKind: string;
  setGroupPosition: (pos: SpacingGroupPosition) => void;
} {
  const modeTheme = theme as ModeTheme;
  const mode = modeOf(modeTheme);
  const dTheme = delegatedTheme(modeTheme, mode);
  let pos: SpacingGroupPosition | undefined;
  const nativeFor = makeNativeCache();
  const comp = styledComponentLike((width: number) => {
    const inner = Math.max(3, width - visibleWidth(RAIL));
    const style = options.style ?? renderStyle();
    const lines: string[] = [];
    const first = pos === undefined || pos.index === 0;
    if (first && options.label !== undefined) {
      lines.push(`${dTheme.fg("accent", "◆")} ${dTheme.fg("accent", dTheme.bold(options.label))}`);
    }
    if (step.kind === "text") {
      if (style === "simple" && pos?.prevKind === "tool") {
        lines.push("");
      }
      lines.push(...styledTextLines(style, step.text, { thinking: expanded ? step.thinking : undefined }, dTheme, inner));
    } else {
      const connector: "├" | "└" = pos?.nextKind === "tool" ? "├" : "└";
      const native = style === "regular" ? nativeFor(step, expanded, inner) : undefined;
      if (native !== undefined) {
        lines.push(...native);
      } else {
        lines.push(...styledToolCallLines(style, {
          name: step.name,
          arg: step.arg,
          output: step.output,
          isError: step.isError,
          expanded,
          durationMs: step.durationMs,
          connector: style === "simple" ? connector : undefined,
        }, dTheme, inner));
      }
    }
    return lines.map((l) => truncateToWidth(l, inner)).map((l) => paintDelegatedLine(l, width, modeTheme));
  }, () => options.style ?? renderStyle());
  comp.spacingGroup = options.group;
  comp.spacingKind = step.kind === "tool" ? "tool" : "text";
  comp.setGroupPosition = (p: SpacingGroupPosition) => {
    // Only a real position change invalidates — the host re-renders twice per
    // pass (initial + positioned), and identical positions must not churn the
    // native/paint caches (and must never invalidate from inside render).
    const same = pos !== undefined && pos.index === p.index && pos.count === p.count && pos.prevKind === p.prevKind && pos.nextKind === p.nextKind;
    pos = p;
    if (!same) comp.invalidate();
  };
  return comp as unknown as Component & {
    spacingGroup: string;
    spacingKind: string;
    setGroupPosition: (pos: SpacingGroupPosition) => void;
  };
}
