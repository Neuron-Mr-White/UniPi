/**
 * @pi-unipi/utility — harness message provenance rendering (UNI-53).
 *
 * Production renderer for harness-generated content: ONE violet ▏ rail
 * (#a78bfa) on a dark-slate fill (#20222d) per row, body markdown rendered at
 * width-2 so nothing is cut, light text forced on the dark fill, blank rows
 * painted. Three densities (simple / regular / advanced) mirroring the approved
 * UNI-49 preview; the expand hint is Ctrl+O (pi\'s real toggle), not the
 * preview\'s "e".
 *
 * THEME: the panel is theme-PARAMETERIZED — the caller passes the host theme it
 * already received (renderer callbacks, entry renderers, the setWidget probe).
 * This module never imports or overrides the global theme; body markdown uses
 * the SDK\'s public getMarkdownTheme() (current global theme) with a forced
 * readable light fg on the dark fill.
 *
 * Also installs:
 *  - registerMessageRenderer for the KNOWN harness custom types (details
 *    `unipiHarness` meta when present, generic type fallback otherwise — never
 *    text detection);
 *  - the native USER card patch: wraps UserMessageComponent.render only, mapped
 *    by strict ordinal alignment against ctx.sessionManager.buildContextEntries()
 *    (compaction-aware), skill blocks excluded via the SDK\'s own parseSkillBlock;
 *  - `withHarnessToolAnnotations(def)` for tool renderers: a provenance header
 *    line for results carrying `unipiHarnessAnnotations` details (text stays
 *    exactly what the handler produced).
 */
import { getMarkdownTheme, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { paintLine } from "./reply-bg.js";
import { findTranscriptContainer } from "./spacing.js";
import { renderStyle, type RenderStyle } from "./styled.js";
import {
  harnessToolResultDetails,
  readHarnessMeta,
  type HarnessDelivery,
  type HarnessMessageMeta,
  type HarnessMessageMetaInput,
  type HarnessToolAnnotation,
} from "@pi-unipi/core";

export type { HarnessToolAnnotation } from "@pi-unipi/core";
export { harnessToolResultDetails, readHarnessMeta } from "@pi-unipi/core";
export type { HarnessMessageMeta, HarnessDelivery } from "@pi-unipi/core";
export type { RenderStyle } from "./styled.js";

// ── palette (fixed dark fill; light text; mode-aware SGR) ───────────────────
interface Palette {
  violet: string;
  warn: string;
  fill: string;
  light: string;
  lightDim: string;
}

const TRUECOLOR: Palette = {
  violet: "\x1b[38;2;167;139;250m", // #a78bfa
  warn: "\x1b[38;2;251;191;36m", // #fbbf24
  fill: "\x1b[48;2;32;34;45m", // #20222d
  light: "\x1b[38;2;232;234;242m", // #e8eaf2
  lightDim: "\x1b[38;2;154;160;181m", // #9aa0b5
};

const COLOR256: Palette = {
  violet: "\x1b[38;5;139m",
  warn: "\x1b[38;5;215m",
  fill: "\x1b[48;5;235m",
  light: "\x1b[38;5;253m",
  lightDim: "\x1b[38;5;245m",
};

type ColorMode = "truecolor" | "256color";

/** Theme surface the panel reads (pi\'s Theme satisfies it). May also be
 * supplied as a FUNCTION resolved per render for dynamic native state. */
export type HarnessThemeCompat = { getColorMode?: () => ColorMode; appearance?: string } | (() => HarnessThemeCompat);

function resolveTheme(theme: HarnessThemeCompat | undefined): { getColorMode?: () => ColorMode; appearance?: string } | undefined {
  return (typeof theme === "function" ? theme() : theme) as { getColorMode?: () => ColorMode; appearance?: string } | undefined;
}

function paletteFor(theme: HarnessThemeCompat | undefined): Palette {
  const mode = resolveTheme(theme)?.getColorMode?.() ?? (process.env.COLORTERM === "truecolor" ? "truecolor" : "256color");
  return mode === "truecolor" ? TRUECOLOR : COLOR256;
}

function modeOf(theme: HarnessThemeCompat | undefined): ColorMode {
  return resolveTheme(theme)?.getColorMode?.() ?? (process.env.COLORTERM === "truecolor" ? "truecolor" : "256color");
}

const FG_RESET = "\x1b[39m";

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function mdLines(text: string, width: number, light: string): string[] {
  if (text.length === 0) return [];
  let markdownTheme: unknown;
  try {
    markdownTheme = getMarkdownTheme(); // SDK public getter — current global theme
  } catch {
    markdownTheme = undefined; // test mocks / uninitialized hosts: plain fallback
  }
  if (markdownTheme === undefined || markdownTheme === null) {
    // Forced readable light fg for the raw fallback (invisible otherwise on
    // light terminals).
    return text.split("\n").flatMap((segment) => {
      if (segment.length === 0) return [""];
      return wrapTextWithAnsi(`${light}${segment}${FG_RESET}`, width);
    });
  }
  const comp = new Markdown(text, 0, 0, markdownTheme as never, { color: (c: string) => `${light}${c}${FG_RESET}` });
  return comp.render(width);
}

export interface HarnessRenderOptions {
  expanded: boolean | (() => boolean);
  style?: RenderStyle | (() => RenderStyle);
}

interface ThemeTagger {
  tag(theme: unknown): string;
  mode(theme: HarnessThemeCompat | undefined): ColorMode;
}

function makeThemeTagger(): ThemeTagger {
  const tags = new WeakMap<object, number>();
  let counter = 0;
  return {
    tag(theme: unknown): string {
      const resolved = resolveTheme(theme as HarnessThemeCompat | undefined);
      if (!resolved || typeof resolved !== "object") return "fn";
      let t = tags.get(resolved);
      if (t === undefined) {
        counter += 1;
        t = counter;
        tags.set(resolved, t);
      }
      return `th${t}`;
    },
    mode(theme: HarnessThemeCompat | undefined): ColorMode {
      return modeOf(theme);
    },
  };
}

const themeTagger = makeThemeTagger();

/** Shared production panel for harness content — full text preserved expanded.
 * `theme`/`options.style` may be functions (dynamic native state); resolved per
 * render and included in the cache key. */
export class HarnessPanel implements Component {
  private cacheKey = "";
  private cache: string[] = [];
  private readonly expandedOf: () => boolean;
  private readonly theme: HarnessThemeCompat | (() => HarnessThemeCompat);

  constructor(
    private readonly content: string,
    private readonly meta: HarnessMessageMeta,
    private readonly options: HarnessRenderOptions,
    theme: HarnessThemeCompat | (() => HarnessThemeCompat),
  ) {
    this.expandedOf = typeof options.expanded === "function" ? options.expanded : () => options.expanded === true;
    this.theme = theme;
  }

  invalidate(): void {
    this.cacheKey = ""; // next render rebuilds (refreshes markdown)
  }

  render(width: number): string[] {
    const style: RenderStyle = typeof this.options.style === "function" ? this.options.style() : this.options.style ?? "simple";
    const theme = resolveTheme(this.theme);
    const expanded = this.expandedOf();
    const key = `${width}|${style}|${expanded}|${this.content.length}|${this.meta.id}|${themeTagger.tag(this.theme)}|${themeTagger.mode(this.theme)}`;
    if (key !== this.cacheKey) {
      this.cache = this.build(width, style, expanded, theme, paletteFor(theme));
      this.cacheKey = key;
    }
    return this.cache;
  }

  private build(width: number, style: RenderStyle, expanded: boolean, theme: HarnessThemeCompat | undefined, pal: Palette): string[] {
    const railGlyph = `${pal.violet}▏${FG_RESET}`;
    const inner = Math.max(8, width - 2);
    const V = (s: string) => `${pal.violet}${s}${FG_RESET}`;
    const W = (s: string) => `${pal.warn}${s}${FG_RESET}`;
    const DIM = (s: string) => `${pal.lightDim}${s}${FG_RESET}`;
    const paint = (line: string): string => paintLine(`${railGlyph} ${line}`, width, pal.fill);
    // Rows are built as PLAIN text, wrapped at the inner width, then colorized
    // wholesale — no ANSI inside the wrap input, so wrapping is width-exact.
    const plainRows = (text: string, colorize: (l: string) => string): string[] =>
      wrapTextWithAnsi(text, inner).map(colorize);
    const warning = this.meta.severity === "warning";
    const label = `${warning ? `${pal.warn}⚠${FG_RESET} ` : ""}UniPi · ${this.meta.source} · ${this.meta.title}`;
    const labelColorize = this.meta.severity === "warning" ? W : V;

    const body = mdLines(this.content, inner, pal.light);
    const out: string[] = [];
    out.push(...plainRows(label, labelColorize));
    if (style === "simple") {
      const synopsis = this.meta.synopsis ?? this.meta.title;
      out.push(...plainRows(synopsis, (l) => (warning ? W(l) : DIM(l))));
      if (expanded) out.push(...body);
      else out.push(...plainRows(`Ctrl+O: full message (${body.length} rendered rows)`, DIM));
    } else if (style === "regular") {
      if (expanded) out.push(...plainRows(detailText(this.meta), DIM));
      for (const l of body) out.push(l);
    } else if (this.meta.lines?.length) {
      // Pre-rendered summary rows (e.g. skill reveals): ONE row per line, then
      // the same expand affordance as simple. No origin footer.
      for (const line of this.meta.lines) out.push(DIM(line));
      if (expanded) out.push(...body);
      else out.push(...plainRows(`Ctrl+O: full message (${body.length} rendered rows)`, DIM));
    } else {
      if (expanded) {
        out.push(...body);
      } else {
        for (const l of body.slice(0, 4)) out.push(l);
        if (body.length > 4) out.push(...plainRows(`Ctrl+O: expand full (${body.length - 4} more rendered rows)`, DIM));
      }
      out.push(...plainRows(`origin: harness | model role: user | delivery: ${this.meta.delivery}`, DIM));
    }
    return out.map((l) => truncateToWidth(l, inner)).map(paint);
  }
}

function detailText(meta: HarnessMessageMeta): string {
  return [
    `id: ${meta.id}`,
    `origin: harness · transport: ${meta.delivery}`,
    meta.synopsis ? `synopsis: ${meta.synopsis}` : "",
  ].filter((r) => r.length > 0).join("\n");
}

/** Public pure entry: build the panel component for a harness message.
 * `theme` is REQUIRED — pass the host theme the caller already received. */
export function renderHarnessMessage(
  content: string,
  meta: HarnessMessageMeta,
  options: HarnessRenderOptions,
  theme: HarnessThemeCompat | (() => HarnessThemeCompat),
): Component {
  return new HarnessPanel(content, meta, options, theme);
}

// ── known custom types ──────────────────────────────────────────────────────
interface KnownType {
  source: string;
  title: string;
  severity?: "warning";
  delivery: HarnessDelivery;
}

/** Faithful per-type fallback delivery (actual transport), stable fallback id. */
export const KNOWN_CUSTOM_TYPES: Record<string, KnownType> = {
  "unipi:lh-continue": { source: "Long-horizon", title: "Continuation", delivery: "boundary" },
  "unipi:kanboard-continue": { source: "Kanboard", title: "Unfinished task", delivery: "boundary" },
  "unipi:kanboard-next": { source: "Kanboard", title: "Next task", delivery: "boundary" },
  "unipi-memory-recall-reminder": { source: "Memory", title: "Memory recall", delivery: "before_agent_start" },
  "unipi-memory-retro-reminder": { source: "Memory", title: "Memory save?", delivery: "nextTurn" },
  "unipi-skills-revealed": { source: "Skills", title: "Skill reveal", delivery: "direct" },
  "unipi:plan-mode-message": { source: "Plan mode", title: "Plan mode", delivery: "direct" },
  "unipi-watchdog": { source: "Watchdog", title: "Warning", severity: "warning", delivery: "before_agent_start" },
  "compactor-recall": { source: "Compactor", title: "Session recall", delivery: "direct" },
  "unipi-response": { source: "Utility", title: "Response", delivery: "followUp" },
};

/** Stable fallback meta (no fresh ids per paint). */
export function fallbackHarnessMeta(customType: string): HarnessMessageMeta {
  const known = KNOWN_CUSTOM_TYPES[customType] ?? { source: customType, title: customType, delivery: "direct" as HarnessDelivery };
  return {
    version: 1,
    id: `hm-fallback-${customType}`,
    delivery: known.delivery,
    source: known.source,
    title: known.title,
    ...(known.severity ? { severity: known.severity } : {}),
  };
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

/** Renderer for the KNOWN harness custom types. Body text unchanged; meta from
 * details.unipiHarness when present, generic type fallback otherwise. */
export function installHarnessRenderers(pi: ExtensionAPI): void {
  for (const customType of Object.keys(KNOWN_CUSTOM_TYPES)) {
    try {
      pi.registerMessageRenderer(customType, ((message: { content?: unknown; details?: unknown }, options: { expanded?: boolean }, theme: HarnessThemeCompat) => {
        const meta = readHarnessMeta(message.details) ?? fallbackHarnessMeta(customType);
        const text = contentText(message.content);
        return renderHarnessMessage(text, meta, {
          expanded: options?.expanded === true,
          style: renderStyle(),
        }, theme);
      }) as never);
    } catch {
      // Renderer registration is UI-dependent; never block load.
    }
  }
}

// ── native USER card patch ──────────────────────────────────────────────────
interface UserComponentLike {
  text: string;
  rebuild: () => void;
  setOutputPad: (pad: number) => void;
  render: (width: number) => string[];
  invalidate?: () => void;
}

interface ExpectedCard {
  entryId: string;
  text: string;
  meta?: HarnessMessageMeta;
}

interface HarnessUiContext {
  cwd?: string;
  sessionManager?: { buildContextEntries: () => Array<{ type?: string; id?: string; message?: unknown }>; getLeafId?: () => string | undefined };
  ui?: { getToolsExpanded?: () => boolean; requestRender?: (force?: boolean) => void };
}

interface Wrapped {
  original: (width: number) => string[];
  originalInvalidate: (() => void) | undefined;
  panel: HarnessPanel;
  metaId: string;
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const MAX_PERSIST_RETRIES = 3;

export function installHarnessUserRendering(pi: ExtensionAPI): void {
  let scheduled = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wrapped = new Map<UserComponentLike, Wrapped>();
  let lastContainer: { children?: unknown[] } | undefined;
  let lastChildrenRef: unknown[] | undefined;
  let lastFirst: unknown;
  let lastLast: unknown;
  let lastLength = -1;
  let lastLeaf: string | undefined;
  let lastTheme: HarnessThemeCompat | undefined;
  let lastCtx: HarnessUiContext;
  let tui: unknown;
  let theme: HarnessThemeCompat | undefined;
  let probeInstalled = false;
  let persistRetries = 0;
  let shuttingDown = false;

  const requestRender = (): void => {
    try {
      (tui as { requestRender?: (force?: boolean) => void } | undefined)?.requestRender?.(true);
    } catch {}
  };

  const schedule = (): void => {
    if (shuttingDown || scheduled) return;
    scheduled = true;
    const t = setTimeout(() => {
      scheduled = false;
      timers.delete(t);
      try {
        reconcile();
      } catch (err) {
      }
    }, 0);
    timers.add(t);
  };

  const captureCtx = (ctx: unknown): void => {
    if (!ctx || typeof ctx !== "object") return;
    lastCtx = ctx as HarnessUiContext;
  };

  const leafId = (): string | undefined => {
    try {
      return lastCtx?.sessionManager?.getLeafId?.();
    } catch {
      return undefined;
    }
  };

  const expectedCards = (): ExpectedCard[] => {
    const sm = lastCtx?.sessionManager;
    if (!sm || typeof sm.buildContextEntries !== "function") return [];
    const out: ExpectedCard[] = [];
    for (const entry of sm.buildContextEntries()) {
      if (entry?.type !== "message") continue;
      const message = entry.message as { role?: unknown; content?: unknown; unipiHarness?: unknown } | undefined;
      if (!message || message.role !== "user") continue;
      const text = contentText(message.content);
      const skill = parseSkillBlock(text);
      if (skill) {
        // Skill blocks render as their own component; a harness-labelled one
        // still wraps its trailing user message. No meta → native.
        if (skill.userMessage) {
          const meta = readHarnessMeta(message);
          out.push({ entryId: String(entry.id), text: skill.userMessage, ...(meta ? { meta } : {}) });
        }
        continue;
      }
      if (text.length === 0) continue; // images-only: no native card
      const meta = readHarnessMeta(message);
      out.push({ entryId: String(entry.id), text, meta });
    }
    return out;
  };

  const isUserComponent = (c: unknown): c is UserComponentLike =>
    !!c && typeof c === "object" &&
    typeof (c as { text?: unknown }).text === "string" &&
    typeof (c as { rebuild?: unknown }).rebuild === "function" &&
    typeof (c as { setOutputPad?: unknown }).setOutputPad === "function" &&
    (c as { message?: unknown }).message === undefined;

  function unpatch(comp: UserComponentLike, w: Wrapped): void {
    comp.render = w.original;
    if (w.originalInvalidate) comp.invalidate = w.originalInvalidate;
    else delete (comp as { invalidate?: unknown }).invalidate;
  }

  function unpatchAll(): boolean {
    if (wrapped.size === 0) return false;
    for (const [comp, w] of wrapped) unpatch(comp, w);
    wrapped.clear();
    return true;
  }

  const reconcile = (): void => {
    const container = findTranscriptContainer(tui) as { children?: unknown[] } | undefined;
    if (!container || !Array.isArray(container.children)) return;
    const children = container.children;
    const comps = children.filter((c): c is UserComponentLike => isUserComponent(c));
    const expected = expectedCards();

    let changed = false;
    let ok = comps.length === expected.length;
    if (ok) {
      for (let i = 0; i < comps.length; i++) {
        if (comps[i]!.text !== expected[i]!.text) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) {
      // Mismatch: fall back to native. Bounded persistence retries after a
      // message_end (the entry may not be visible yet); then stop rescheduling.
      changed = unpatchAll();
      if (persistRetries > 0) {
        persistRetries -= 1;
        schedule();
      }
    } else {
      persistRetries = 0;
      // Prune wrapped entries whose component is absent.
      for (const comp of [...wrapped.keys()]) {
        if (!comps.includes(comp)) {
          unpatch(comp, wrapped.get(comp)!);
          wrapped.delete(comp);
          changed = true;
        }
      }
      for (let i = 0; i < comps.length; i++) {
        const comp = comps[i]!;
        const meta = expected[i]!.meta;
        const existing = wrapped.get(comp);
        if (!meta) {
          if (existing) {
            unpatch(comp, existing);
            wrapped.delete(comp);
            changed = true;
          }
          continue;
        }
        if (existing && existing.metaId === meta.id) continue;
        // New wrap OR metadata changed (same component) → (re)create the panel.
        if (existing) unpatch(comp, existing);
        const panel = new HarnessPanel(comp.text, meta, {
          expanded: () => lastCtx?.ui?.getToolsExpanded?.() === true,
          style: () => renderStyle(lastCtx?.cwd) as RenderStyle,
        }, () => theme ?? { getColorMode: () => (process.env.COLORTERM === "truecolor" ? "truecolor" : "256color") });
        const original = comp.render.bind(comp);
        const originalInvalidate = comp.invalidate?.bind(comp);
        const osc = (rows: string[]): string[] => {
          if (rows.length === 0) return rows;
          const o = [...rows];
          o[0] = OSC133_ZONE_START + o[0]!;
          o[o.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + o[o.length - 1]!;
          return o;
        };
        comp.render = (w: number) => osc(panel.render(w));
        comp.invalidate = () => {
          panel.invalidate();
          originalInvalidate?.();
        };
        wrapped.set(comp, { original, originalInvalidate, panel, metaId: meta.id });
        changed = true;
      }
    }

    // Store the O(1) probe fields AFTER this pass — both paths.
    lastContainer = container;
    lastChildrenRef = children;
    lastLength = children.length;
    lastFirst = children[0];
    lastLast = children[children.length - 1];
    lastLeaf = leafId();
    lastTheme = theme;

    if (changed) requestRender();
  };

  /** O(1) probe against the stored identity fields. */
  const probe = (): void => {
    if (shuttingDown) return;
    const container = findTranscriptContainer(tui) as { children?: unknown[] } | undefined;
    if (!container) return;
    const children = container.children;
    if (!Array.isArray(children)) return;
    const leaf = leafId();
    if (
      container !== lastContainer ||
      children !== lastChildrenRef ||
      children.length !== lastLength ||
      children[0] !== lastFirst ||
      children[children.length - 1] !== lastLast ||
      leaf !== lastLeaf ||
      theme !== lastTheme
    ) {
      schedule();
    }
  };

  try {
    pi.on("session_start", ((_event: unknown, ctx: unknown) => {
      captureCtx(ctx);
      // AFTER event on a FRESH context: re-register the probe widget.
      probeInstalled = false;
      const c = lastCtx as { hasUI?: boolean; ui?: { setWidget?: (name: string, render: (t: unknown, th: unknown) => unknown, opts?: unknown) => void } } | undefined;
      if (!c?.hasUI || probeInstalled || typeof c.ui?.setWidget !== "function") return;
      probeInstalled = true;
      try {
        // 0-height probe widget: the factory captures root+theme once; the
        // render callback runs per frame and O(1)-probes for changes.
        c.ui.setWidget(
          "unipi.harnessUserProbe",
          (t: unknown, th: unknown) => {
            tui = t;
            theme = th as HarnessThemeCompat;
            probe();
            return {
              invalidate(): void {
                schedule();
              },
              render(): string[] {
                probe();
                return [];
              },
            };
          },
          { placement: "belowEditor" },
        );
      } catch {}
    }) as never);
  } catch {
    // optional
  }
  const onAny = pi.on as unknown as (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
  for (const evt of ["message_start", "message_end", "agent_start"]) {
    onAny(evt, (event, ctx) => {
      if (ctx) captureCtx(ctx);
      if (evt === "message_end") persistRetries = MAX_PERSIST_RETRIES;
      schedule();
    });
  }
  for (const evt of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
    // BEFORE events: cancel stale pending work — do not apply the old tree.
    onAny(evt, () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      scheduled = false;
    });
  }
  for (const evt of ["session_tree", "session_compact"]) {
    // AFTER events: full rebind against the new tree.
    onAny(evt, (_event, ctx) => {
      if (ctx) captureCtx(ctx);
      persistRetries = MAX_PERSIST_RETRIES;
      schedule();
    });
  }
  onAny("session_shutdown", () => {
    shuttingDown = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    unpatchAll();
  });
}


// ── tool annotations ────────────────────────────────────────────────────────
const ANNOTATION_WRAPPED = Symbol.for("unipi.harnessToolAnnotations");

export function isHarnessAnnotated(def: object): boolean {
  return Boolean((def as { [ANNOTATION_WRAPPED]?: boolean })[ANNOTATION_WRAPPED]);
}

export function markHarnessAnnotated(def: object): void {
  if (isHarnessAnnotated(def)) return;
  Object.defineProperty(def, ANNOTATION_WRAPPED, { value: true, enumerable: false, configurable: true });
}

function annotationsOf(result: unknown): HarnessToolAnnotation[] {
  const details = (result as { details?: { unipiHarnessAnnotations?: unknown } } | null | undefined)?.details;
  const list = details?.unipiHarnessAnnotations;
  if (!Array.isArray(list)) return [];
  return list.filter((a): a is HarnessToolAnnotation => {
    const meta = (a as { meta?: unknown })?.meta;
    const text = (a as { text?: unknown })?.text;
    return !!meta && typeof text === "string" && readHarnessMeta({ unipiHarness: meta }) !== undefined;
  });
}

/** Width-aware lazy composite: renders base + annotation rows at call width.
 * `base` may be a Component (live width) or pre-rendered rows (string[]). */
function composeWithRows(base: unknown, rows: (width: number) => string[]): Component {
  const inner = base as Component | undefined;
  if (inner && typeof inner.render === "function") {
    return {
      render(width: number): string[] {
        return [...inner.render(width), ...rows(width)];
      },
      invalidate(): void {
        inner?.invalidate?.();
      },
    };
  }
  const fixed = Array.isArray(base) ? (base as string[]) : base !== undefined && base !== null ? [String(base)] : [];
  return {
    render(width: number): string[] {
      return [...fixed, ...rows(width)];
    },
    invalidate(): void {},
  };
}

/** Wrap a tool renderer definition so results carrying `unipiHarnessAnnotations`
 * get a provenance header. Original output (including the annotation text
 * itself, shown exactly once) is untouched; defs without annotations render
 * EXACTLY as before; defs without a renderResult keep the native default.
 * Idempotent per definition (mutates + marks). */
export function withHarnessToolAnnotations<T extends object>(def: T & { name?: string }): T {
  if (isHarnessAnnotated(def)) return def;
  const anyDef = def as { [ANNOTATION_WRAPPED]?: boolean; renderResult?: unknown; simpleResult?: unknown; name?: string };
  const toolName = typeof anyDef.name === "string" ? anyDef.name : undefined;
  const headerFor = (result: unknown): string[] => {
    const pal = paletteFor(undefined);
    const rows: string[] = [];
    for (const a of annotationsOf(result)) {
      const glyph = a.meta.severity === "warning" ? `${pal.warn}⚠${FG_RESET}` : `${pal.violet}◇${FG_RESET}`;
      rows.push(`${glyph} UniPi · ${pal.violet}${a.meta.source}${FG_RESET} · ${a.meta.title}${toolName ? ` · ${toolName} guidance` : " · tool guidance"}`);
      if (a.meta.synopsis) rows.push(`  ${a.meta.synopsis}`);
    }
    return rows;
  };
  if (typeof anyDef.renderResult === "function") {
    const original = anyDef.renderResult as unknown as (r: unknown, o: unknown, t: unknown, c?: unknown) => unknown;
    anyDef.renderResult = ((result: unknown, options: unknown, theme: unknown, ctx: unknown) => {
      const out: unknown = original(result, options, theme, ctx);
      if (annotationsOf(result).length === 0) return out;
      return composeWithRows(out, (width) => headerFor(result).map((l) => truncateToWidth(l, width)));
    }) as unknown as (result: never, options: never, theme: never, ctx: never) => unknown;
  }
  const originalSimple = anyDef.simpleResult as unknown as ((r: unknown, t: unknown, c?: unknown) => unknown) | undefined;
  anyDef.simpleResult = ((result: unknown, theme: unknown, ctx?: unknown) => {
    const base: unknown = originalSimple ? originalSimple(result, theme, ctx) : undefined;
    const anns = annotationsOf(result);
    if (anns.length === 0) return base;
    return composeWithRows(base, (width) =>
      anns.flatMap((a) =>
        wrapTextWithAnsi(`⚠ UniPi · ${a.meta.source} · ${a.meta.synopsis ?? a.meta.title}`, width),
      ),
    );
  }) as unknown as (result: never, theme: never, ctx?: never) => unknown;
  markHarnessAnnotated(def);
  return def;
}
