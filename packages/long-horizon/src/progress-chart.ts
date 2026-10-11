/**
 * Chart mode for `/unipi:visualize-progress` (UNI-258): the shared mermaid
 * source (progress-mermaid.ts) → SVG → PNG → an inline terminal image.
 *
 * Renderer choice: no browser. `beautiful-mermaid` lays the flowchart out in
 * pure JS (ELK) and emits SVG; `@resvg/resvg-wasm` rasterises it (WASM, so no
 * native binary that could fail to load — see UNI-261). Both are imported
 * lazily on first use, so the text view never pays for them, and if either
 * is missing the view stays in text mode with a reason.
 *
 * resvg understands neither CSS custom properties nor color-mix(), which
 * beautiful-mermaid uses for its derived colours, so the SVG is flattened to
 * literal colours before rasterising (`flattenSvgColors`).
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { allocateImageId, encodeKitty, getCapabilities, getPngDimensions, getCellDimensions, type ImageProtocol } from "@earendil-works/pi-tui";
import type { LhProgressRun } from "@pi-unipi/core";
import { hasProgressChart, progressMermaid } from "./progress-mermaid.js";

/** Chart palette (app tokens): page background and primary text. */
export const CHART_BG = "#0F0D0C";
export const CHART_FG = "#F5EFE6";

// ── colour flattening ───────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function rgbToHex([r, g, b]: number[]): string {
  return `#${[r!, g!, b!].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Resolve `var(--x)` / `var(--x, fallback)` / `color-mix(in srgb, A p%, B)`
 * against `vars` until only literals remain.
 */
export function resolveCssColor(value: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 12) return value;
  let v = value.trim();
  // Innermost var() first.
  const varRe = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*(?:\([^()]*\))?[^()]*\))?[^()]*))?\)/;
  let guard = 0;
  while (varRe.test(v) && guard++ < 64) {
    v = v.replace(varRe, (_m, name: string, fallback?: string) => {
      const hit = vars[name];
      if (hit !== undefined) return resolveCssColor(hit, vars, depth + 1);
      return fallback !== undefined ? resolveCssColor(fallback, vars, depth + 1) : "#000000";
    });
  }
  const mixRe = /color-mix\(\s*in\s+srgb\s*,\s*(#[0-9a-fA-F]{3,6})\s+([\d.]+)%\s*,\s*(#[0-9a-fA-F]{3,6})\s*\)/;
  guard = 0;
  while (mixRe.test(v) && guard++ < 64) {
    v = v.replace(mixRe, (_m, a: string, pct: string, b: string) => {
      const ra = hexToRgb(a);
      const rb = hexToRgb(b);
      if (!ra || !rb) return a;
      const p = Math.max(0, Math.min(100, Number(pct))) / 100;
      return rgbToHex(ra.map((x, i) => x * p + rb[i]! * (1 - p)));
    });
  }
  return v;
}

/** Replace every CSS-variable / color-mix colour in an SVG with a literal, and drop the web-font import. */
export function flattenSvgColors(svg: string, base: Record<string, string>): string {
  const vars: Record<string, string> = { ...base };
  // Custom properties declared in the <style> block (`--_text: var(--fg);`).
  const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
  for (const m of style.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!(m[1]! in vars)) vars[m[1]!] = m[2]!.trim();
  }
  // …and inline on the root element (`style="--bg:#…;--fg:#…"`).
  const rootStyle = /<svg[^>]*\sstyle="([^"]*)"/.exec(svg)?.[1] ?? "";
  for (const m of rootStyle.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) vars[m[1]!] = m[2]!.trim();

  let out = svg.replace(/@import url\([^)]*\);?/g, "");
  out = out.replace(/(fill|stroke|color|stop-color)="([^"]*(?:var\(|color-mix\()[^"]*)"/g, (_m, attr: string, val: string) => `${attr}="${resolveCssColor(val, vars)}"`);
  out = out.replace(/(fill|stroke|background|color)\s*:\s*((?:var\(|color-mix\()[^;"]*)/g, (_m, prop: string, val: string) => `${prop}:${resolveCssColor(val, vars)}`);
  // resvg ignores the CSS `background`; paint it as the first child instead.
  const bg = vars["--bg"] ? resolveCssColor(vars["--bg"], vars) : undefined;
  if (bg) out = out.replace(/(<svg[^>]*>)/, `$1<rect x="-10000" y="-10000" width="40000" height="40000" fill="${bg}"/>`);
  return out;
}

/**
 * beautiful-mermaid ignores invisible `~~~` links, so the swarm grid the app
 * gets from real mermaid collapses into one shuffled column. `direction LR`
 * inside the items subgraph makes its layout pack the nodes into an ordered
 * grid instead. Renderer-side only — the shared source stays what the app uses.
 */
export function adaptForBeautifulMermaid(source: string): string {
  if (!/^ {2}subgraph items\[/m.test(source)) return source;
  return source
    .split("\n")
    .filter((l) => !/^\s+\S+( ~~~ \S+)+$/.test(l))
    .map((l) => (/^ {2}subgraph items\[/.test(l) ? `${l}\n    direction LR` : l))
    .join("\n");
}

// ── renderer ────────────────────────────────────────────────────────────────

/** Fonts with the status glyphs (✓ ▶ · ○ ⊘ ✗) per platform; the first that exists is the default family. */
export const FONT_CANDIDATES: string[] = [
  // Linux
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  // macOS
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Apple Symbols.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  // Windows
  `${process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"}\\Fonts\\segoeui.ttf`,
  `${process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"}\\Fonts\\seguisym.ttf`,
  `${process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows"}\\Fonts\\arial.ttf`,
];

export interface ChartRenderer {
  /** Mermaid source → PNG bytes. */
  render(source: string): Promise<Uint8Array>;
}

type BeautifulMermaid = { renderMermaidSVG(src: string, opts?: Record<string, unknown>): string };
type ResvgModule = {
  initWasm(input: unknown): Promise<void>;
  Resvg: new (svg: string, opts?: Record<string, unknown>) => { render(): { asPng(): Uint8Array } };
};

let rendererPromise: Promise<ChartRenderer> | null = null;
let rendererError: string | null = null;

/** Non-literal specifiers so the bundler leaves these as runtime imports. */
async function importOptional<T>(name: string): Promise<T> {
  const spec = name;
  return (await import(/* @vite-ignore */ spec)) as T;
}

/** resvg's WASM is process-global and may be initialised exactly once. */
let wasmReady: Promise<void> | null = null;

async function createDefaultRenderer(): Promise<ChartRenderer> {
  const bm = await importOptional<BeautifulMermaid>("beautiful-mermaid");
  const resvg = await importOptional<ResvgModule>("@resvg/resvg-wasm");
  if (!wasmReady) {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
    wasmReady = resvg.initWasm(readFileSync(wasmPath)).catch((err: unknown) => {
      // initWasm may only run once per process; a second call means it's ready.
      if (/already initiali[sz]ed/i.test((err as Error)?.message ?? "")) return;
      wasmReady = null;
      throw err;
    });
  }
  await wasmReady;
  const fontFiles = FONT_CANDIDATES.filter((f) => {
    try {
      return existsSync(f);
    } catch {
      return false;
    }
  });
  const fontBuffers = fontFiles.map((f) => readFileSync(f));
  if (!fontBuffers.length) throw new Error("no system font found for chart labels");
  return {
    async render(source: string) {
      const svg = bm.renderMermaidSVG(adaptForBeautifulMermaid(source), { bg: CHART_BG, fg: CHART_FG, font: "sans-serif", padding: 16 });
      const flat = flattenSvgColors(svg, { "--bg": CHART_BG, "--fg": CHART_FG });
      const r = new resvg.Resvg(flat, {
        font: { fontBuffers, loadSystemFonts: false, defaultFontFamily: undefined, sansSerifFamily: undefined },
        fitTo: { mode: "zoom", value: 2 },
        background: CHART_BG,
      });
      return r.render().asPng();
    },
  };
}

let rendererFactory: () => Promise<ChartRenderer> = createDefaultRenderer;

/** The chart renderer, created once. Rejects (and remembers why) when a piece is missing. */
export function getChartRenderer(): Promise<ChartRenderer> {
  if (!rendererPromise) {
    rendererPromise = rendererFactory().catch((err: unknown) => {
      rendererError = (err as Error)?.message ?? String(err);
      throw err;
    });
  }
  return rendererPromise;
}

export function chartRendererError(): string | null {
  return rendererError;
}

/** Test seam. */
export function setChartRendererFactoryForTests(factory: (() => Promise<ChartRenderer>) | null): void {
  rendererFactory = factory ?? createDefaultRenderer;
  rendererPromise = null;
  rendererError = null;
}

/** Inline image protocol of this terminal, or null (text view only). */
export function chartImageProtocol(): ImageProtocol {
  try {
    return getCapabilities().images;
  } catch {
    return null;
  }
}

// ── live chart state (one per open overlay) ─────────────────────────────────

/** Minimum gap between two re-renders while the run changes (≈1/s). */
export const CHART_THROTTLE_MS = 1000;

export interface ChartFrame {
  source: string;
  base64: string;
  widthPx: number;
  heightPx: number;
}

/**
 * Keeps the PNG for the shown run in step with its mermaid source: renders
 * only when the source changes, at most once per CHART_THROTTLE_MS, never
 * two at a time; `onFrame` fires when a new PNG is ready.
 */
export class LiveChart {
  frame: ChartFrame | undefined;
  error: string | undefined;
  private wanted: string | undefined;
  private busy = false;
  private lastStart = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly onFrame: () => void, private readonly now: () => number = Date.now) {}

  /** Ask for the chart of `run` (no-op when nothing changed). */
  update(run: Pick<LhProgressRun, "mode" | "title" | "counts" | "items"> | undefined): void {
    if (this.disposed) return;
    if (!hasProgressChart(run)) {
      this.wanted = undefined;
      return;
    }
    const source = progressMermaid(run!);
    if (source === this.wanted) return;
    this.wanted = source;
    this.schedule();
  }

  private schedule(): void {
    if (this.busy || this.timer || this.disposed) return;
    const wait = Math.max(0, this.lastStart + CHART_THROTTLE_MS - this.now());
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, wait);
      this.timer.unref?.();
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    const source = this.wanted;
    if (!source || source === this.frame?.source) return;
    this.busy = true;
    this.lastStart = this.now();
    try {
      const renderer = await getChartRenderer();
      const png = await renderer.render(source);
      if (this.disposed) return;
      const base64 = Buffer.from(png).toString("base64");
      const dims = getPngDimensions(base64) ?? { widthPx: 800, heightPx: 600 };
      this.frame = { source, base64, widthPx: dims.widthPx, heightPx: dims.heightPx };
      this.error = undefined;
      this.onFrame();
    } catch (err) {
      this.error = (err as Error)?.message ?? String(err);
      this.onFrame();
    } finally {
      this.busy = false;
      if (!this.disposed && this.wanted && this.wanted !== this.frame?.source && !this.error) this.schedule();
    }
  }

  /** True when the frame matches the run currently wanted. */
  get current(): boolean {
    return !!this.frame && this.frame.source === this.wanted;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

// ── terminal lines ──────────────────────────────────────────────────────────

/** Cell box the image gets inside `maxCols × maxRows`, keeping its aspect ratio. */
export function chartCellSize(frame: Pick<ChartFrame, "widthPx" | "heightPx">, maxCols: number, maxRows: number): { columns: number; rows: number } {
  const cell = getCellDimensions();
  const cols = Math.max(1, Math.floor(maxCols));
  const rows = Math.max(1, Math.floor(maxRows));
  const scale = Math.min((cols * cell.widthPx) / Math.max(1, frame.widthPx), (rows * cell.heightPx) / Math.max(1, frame.heightPx));
  return {
    columns: Math.max(1, Math.min(cols, Math.round((frame.widthPx * scale) / cell.widthPx))),
    rows: Math.max(1, Math.min(rows, Math.round((frame.heightPx * scale) / cell.heightPx))),
  };
}

/**
 * The image as `rows` lines for a component: line 0 carries the Kitty escape
 * (drawn without moving the cursor, `C=1`), the rest are blank. Only Kitty:
 * iTerm2's inline images move the cursor, which an overlay composited into
 * pi's frame cannot absorb — those terminals keep the text view.
 */
export function chartImageLines(frame: ChartFrame, columns: number, rows: number, imageId: number): string[] {
  const seq = encodeKitty(frame.base64, { columns, rows, imageId, moveCursor: false });
  return [seq, ...Array.from({ length: rows - 1 }, () => "")];
}

/** Chart mode works on Kitty-graphics terminals (kitty, ghostty, wezterm, …; PI_IMAGE_PROTOCOL=kitty). */
export function chartSupported(protocol: ImageProtocol = chartImageProtocol()): boolean {
  return protocol === "kitty";
}

export { allocateImageId };

/** Default font search for diagnostics/tests. */
export function availableChartFonts(): string[] {
  return FONT_CANDIDATES.filter((f) => existsSync(f)).map((f) => join(f));
}
