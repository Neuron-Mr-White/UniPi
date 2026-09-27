#!/usr/bin/env -S npx tsx
// UniPi TUI gallery: a standalone (no pi session) browser of TUI styles.
// Rendering goes through pi-tui and Pi's own theme loader, so every preview is
// something a UniPi extension can actually ship.
//
//   npm run tui:gallery            (or: npx tsx scripts/tui-gallery/index.ts)
//
// Picks are saved to ~/.unipi/tui-gallery/picks.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchesKey, ProcessTerminal, TuiMainScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { CAPABILITIES, type Variant } from "./capabilities.ts";
import { FAMILIES, SURFACES, wholeLook } from "./families.ts";
import { type Ctx, fit, type Th } from "./kit.ts";
import { badge, DEFAULT_SPINNER, leader, progressBar, SPINNER_MS, SPINNER_STYLES, spinnerCells, spinnerFrame, settledGlyph, type KitTheme } from "../../packages/core/src/tui/kit.ts";

// ── Pi theme loading (same resolver Pi uses, including custom themes) ──────
const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/theme/theme.js")).href)) as {
  getAvailableThemes(): string[];
  getThemeByName(name: string): Th | undefined;
};
const piDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
function configuredTheme(): string {
  try {
    const s = JSON.parse(readFileSync(join(piDir, "settings.json"), "utf8")) as { theme?: string };
    return s.theme && !s.theme.includes(":") ? s.theme : "dark";
  } catch {
    return "dark";
  }
}
const themes = themeMod.getAvailableThemes();
let themeIdx = Math.max(0, themes.indexOf(configuredTheme()));
let theme: Th = themeMod.getThemeByName(themes[themeIdx]!)!;

// ── Sections ───────────────────────────────────────────────────────────────
interface Section {
  id: string;
  group: string;
  title: string;
  note: string;
  variants: Variant[];
}

const GLYPHS: Array<[string, string, string[]]> = [
  ["geometric", "Today's set. Readable everywhere.", ["◐", "✓", "✗", "⊘", "◌"]],
  ["dots", "State by color alone; calm, but weak for color-blind users.", ["●", "●", "●", "●", "○"]],
  ["checks", "Heavier marks; reads well at a glance.", ["◍", "✔", "✘", "⊖", "◌"]],
  ["circled", "Uniform circle family.", ["◉", "⊙", "⊗", "⊖", "○"]],
  ["squares", "Pairs with ▣ kanboard.", ["▣", "■", "⊠", "□", "⬚"]],
  ["ascii", "Works in any font / log file.", ["~", "+", "x", "-", "."]],
];
const glyphVariants: Variant[] = GLYPHS.map(([id, note, g]) => ({
  id,
  name: id,
  note,
  render: ({ t }) => {
    const labels = ["running", "completed", "failed", "cancelled", "queued"];
    const colors = ["accent", "success", "error", "muted", "dim"] as const;
    return [labels.map((l, i) => `${t.fg(colors[i]!, g[i]!)} ${t.fg("muted", l)}`).join("   ")];
  },
}));

// The real crafted spinners from @pi-unipi/core (what UniPi ships).
const SPINNER_NOTES: Record<string, string> = {
  orbit: "A dot circling a 2-cell braille grid with a fading tail.",
  comet: "A comet bouncing across 3 cells, trail fading behind it.",
  scanner: "◆ sweeping over 3 cells with ◇ neighbours. Matches the ◆ strip icon.",
  helix: "A sine wave scrolling through 2 braille cells.",
  diamond: "Single cell ◇ ◈ ◆ with a brightness pulse. Most compact.",
  bars: "Three bars breathing out of phase, equalizer-like.",
  quad: "A quarter block rotating. Simple, blocky.",
};
const spinnerVariants: Variant[] = SPINNER_STYLES.map((style) => ({
  id: style,
  name: `${style}${style === DEFAULT_SPINNER ? "  (current default)" : ""}`,
  note: `${SPINNER_NOTES[style] ?? ""} ${String(spinnerCells(style))} cell${spinnerCells(style) === 1 ? "" : "s"}.`,
  animated: true,
  render: ({ t, width, frame }) => {
    const k = t as unknown as KitTheme;
    // The gallery ticks every 80ms; step the spinner at its own speed.
    const n = Math.floor((frame * 80) / SPINNER_MS);
    const s = spinnerFrame(k, style, n);
    const pad = " ".repeat(Math.max(0, 3 - spinnerCells(style)));
    return [
      `${s}${pad}  ${t.fg("dim", "frames:")} ${Array.from({ length: 8 }, (_, i) => spinnerFrame(k, style, i)).join(t.fg("dim", " "))}`,
      "",
      `${s} ${t.bold("General subagent")} Run root scripts report`,
      `  ${t.fg("dim", "└ Running · 7s · 2 tool calls · ctrl+b background · esc cancel")}`,
      `${t.fg("success", settledGlyph("✓", style))} ${t.bold("General subagent")} Run root scripts report`,
      `  ${t.fg("dim", "└ ")}${t.fg("success", "Completed")}${t.fg("dim", " · 10s · 3 tool calls")}`,
      leader(k, `${badge(k, "accent", "WAIT")} Subagent UX smoke artifact`, `${s} ${t.fg("dim", "12s")}`, width),
    ];
  },
}));

const progressVariants: Variant[] = [
  {
    id: "bars",
    name: "Progress bars",
    note: "Solid = done, shade = in progress, light = left. Posted once per update, only you see them.",
    render: ({ t }) => {
      const k = t as unknown as KitTheme;
      return [
        `${t.fg("accent", "↻")} ${t.bold("Ralph · docs-cleanup")}  ${progressBar(k, 4, 2, 10)}  4/10 items  ${t.fg("dim", "iteration 3/20")}`,
        `  ${t.fg("muted", "next: fix README links · drop old badges")}`,
        `${t.fg("accent", "◎")} ${t.bold("Goal")}  ${progressBar(k, 55, 10, 100)}  ~55%  ${t.fg("dim", "turn 4/30")}`,
        `  ${t.fg("muted", "Parser and CLI flags done; tests for the error paths are left.")}`,
        `${t.fg("success", "▣")} ${t.bold("Board · unipi")}  ${progressBar(k, 5, 1, 10, 20, "success")}  5/10 tasks  ${t.fg("dim", "1 blocked")}`,
      ];
    },
  },
];

const familyNote = (id: string) => FAMILIES.find((f) => f.id === id)!.note;
const SECTIONS: Section[] = [
  {
    id: "whole",
    group: "Design families",
    title: "Whole look",
    note: "Each variant is one family applied to every surface. Pick the family you like; per-surface sections below let you mix.",
    variants: FAMILIES.map((f) => ({ id: f.id, name: f.name, note: f.note, animated: true, render: (c: Ctx) => wholeLook(f, c) })),
  },
  ...SURFACES.map((s) => ({
    id: s.id,
    group: "Surfaces",
    title: s.title,
    note: s.note,
    variants: FAMILIES.map((f) => ({ id: f.id, name: f.name, note: familyNote(f.id), animated: true, render: f.render[s.id] })),
  })),
  { id: "spinner", group: "Details", title: "Spinner lab", note: "Crafted spinners from @pi-unipi/core — pick one with space and tell me; the default switches everywhere at once.", variants: spinnerVariants },
  { id: "progress", group: "Details", title: "Progress bars", note: "Ralph, goal (estimated) and board bars.", variants: progressVariants },
  { id: "glyphs", group: "Details", title: "Status glyphs", note: "One glyph per state, used by strip, dock, cards.", variants: glyphVariants },
  { id: "caps", group: "What a terminal can do", title: "Capabilities & limits", note: "Reference, not a choice. Each demo says where it breaks.", variants: CAPABILITIES },
];

// ── Picks ──────────────────────────────────────────────────────────────────
const picksPath = join(homedir(), ".unipi", "tui-gallery", "picks.json");
const picks: Record<string, string[]> = (() => {
  try {
    return (JSON.parse(readFileSync(picksPath, "utf8")) as { picks?: Record<string, string[]> }).picks ?? {};
  } catch {
    return {};
  }
})();
function savePicks(): void {
  if (!existsSync(dirname(picksPath))) mkdirSync(dirname(picksPath), { recursive: true });
  writeFileSync(picksPath, `${JSON.stringify({ updated: new Date().toISOString(), theme: themes[themeIdx], picks }, null, 2)}\n`);
}
const isPicked = (s: Section, v: Variant) => picks[s.id]?.includes(v.id) ?? false;
function togglePick(s: Section, v: Variant): void {
  const list = new Set(picks[s.id] ?? []);
  if (list.has(v.id)) list.delete(v.id);
  else list.add(v.id);
  if (list.size) picks[s.id] = [...list];
  else delete picks[s.id];
  savePicks();
}

// ── App ────────────────────────────────────────────────────────────────────
const SIDEBAR = 30;

class Gallery implements Component {
  section = 0;
  variant = 0;
  scroll = 0;
  frame = 0;
  sidebar = true;
  solo = false;
  private follow = true;
  private lastVariantTop: number[] = [];
  private lastBodyHeight = 0;

  constructor(private readonly term: ProcessTerminal, private readonly quit: () => void) {}

  invalidate(): void {}

  private get sec(): Section {
    return SECTIONS[this.section]!;
  }

  private preview(width: number): string[] {
    const t = theme;
    const s = this.sec;
    const out: string[] = [];
    out.push(t.bold(t.fg("mdHeading", s.title)));
    for (const l of wrapTextWithAnsi(t.fg("dim", s.note), width)) out.push(l);
    out.push("");
    const tops: number[] = [];
    s.variants.forEach((v, i) => {
      if (this.solo && i !== this.variant) {
        tops.push(out.length);
        return;
      }
      tops.push(out.length);
      const sel = i === this.variant;
      const mark = sel ? t.fg("accent", "▶") : " ";
      const heart = isPicked(s, v) ? ` ${t.fg("error", "♥ picked")}` : "";
      const name = sel ? t.bold(t.fg("accent", v.name)) : t.bold(v.name);
      out.push(`${mark} ${t.fg("dim", `${String(i + 1)}.`)} ${name}${heart}`);
      for (const l of wrapTextWithAnsi(t.fg("dim", v.note), width - 2)) out.push(`  ${l}`);
      out.push(t.fg(sel ? "accent" : "borderMuted", "┈".repeat(Math.min(width, 60))));
      const ctx: Ctx = { t, width: width - 2, frame: this.frame };
      let lines: string[];
      try {
        lines = v.render(ctx);
      } catch (e) {
        lines = [t.fg("error", `render error: ${(e as Error).message}`)];
      }
      for (const l of lines) out.push(`  ${l}`);
      out.push("");
    });
    this.lastVariantTop = tops;
    return out;
  }

  private side(height: number): string[] {
    const t = theme;
    const out: string[] = [];
    let group = "";
    SECTIONS.forEach((s, i) => {
      if (s.group !== group) {
        group = s.group;
        if (out.length) out.push("");
        out.push(t.fg("dim", group.toUpperCase()));
      }
      const n = picks[s.id]?.length ?? 0;
      const label = `${i === this.section ? "▸" : " "} ${s.title}`;
      const right = n ? t.fg("error", ` ♥${String(n)}`) : "";
      const line = fit(label, SIDEBAR - 2 - visibleWidth(right)) + right;
      out.push(i === this.section ? t.bg("selectedBg", t.bold(line)) : line);
    });
    while (out.length < height) out.push("");
    return out.slice(0, height);
  }

  render(width: number): string[] {
    const t = theme;
    const rows = Math.max(10, this.term.rows - 1);
    const totalPicks = Object.values(picks).reduce((a, l) => a + l.length, 0);
    const head = ` ${t.bold("UniPi TUI gallery")}  ${t.fg("dim", `theme ${themes[themeIdx]} · ${t.getColorMode()} · ${String(width)}×${String(this.term.rows)}`)}`;
    const picksLabel = t.fg(totalPicks ? "error" : "dim", `♥ ${String(totalPicks)} picked `);
    const header = fit(head, width - visibleWidth(picksLabel)) + picksLabel;
    const keys = t.fg(
      "dim",
      " ↑↓ variant · ←→/tab section · space pick ♥ · f solo · s sidebar · t theme · pgup/pgdn scroll · q quit",
    );
    const bodyH = rows - 3;
    this.lastBodyHeight = bodyH;
    const pw = this.sidebar ? width - SIDEBAR - 3 : width - 2;
    const full = this.preview(pw);
    // After a selection change, bring the selected variant's header into view.
    if (this.follow) {
      const top = this.lastVariantTop[this.variant] ?? 0;
      if (top < this.scroll || top >= this.scroll + bodyH - 3) this.scroll = this.variant === 0 ? 0 : Math.max(0, top - 1);
      this.follow = false;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, full.length - bodyH)));
    const view = full.slice(this.scroll, this.scroll + bodyH);
    while (view.length < bodyH) view.push("");
    const more = full.length > this.scroll + bodyH ? t.fg("dim", ` ↓ ${String(full.length - this.scroll - bodyH)} more lines`) : "";
    const side = this.side(bodyH);
    const body = view.map((l, i) =>
      this.sidebar ? `${fit(side[i]!, SIDEBAR)} ${t.fg("borderMuted", "│")} ${fit(l, pw)}` : ` ${fit(l, pw)}`,
    );
    return [header, t.fg("borderMuted", "─".repeat(width)), ...body, truncateToWidth(more ? `${keys}  ${more}` : keys, width)];
  }

  handleInput(data: string): void {
    const n = this.sec.variants.length;
    if (matchesKey(data, "ctrl+c") || data === "q" || matchesKey(data, "escape")) return this.quit();
    if (matchesKey(data, "up") || data === "k") this.variant = (this.variant - 1 + n) % n;
    else if (matchesKey(data, "down") || data === "j") this.variant = (this.variant + 1) % n;
    else if (matchesKey(data, "right") || matchesKey(data, "tab") || data === "l") this.goSection(1);
    else if (matchesKey(data, "left") || matchesKey(data, "shift+tab") || data === "h") this.goSection(-1);
    else if (matchesKey(data, "pageDown")) this.scroll += Math.max(1, this.lastBodyHeight - 2);
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - Math.max(1, this.lastBodyHeight - 2));
    else if (data === " ") togglePick(this.sec, this.sec.variants[this.variant]!);
    else if (data === "f") this.solo = !this.solo;
    else if (data === "s") this.sidebar = !this.sidebar;
    else if (data === "t") {
      themeIdx = (themeIdx + 1) % themes.length;
      theme = themeMod.getThemeByName(themes[themeIdx]!) ?? theme;
    } else if (/^[1-9]$/.test(data) && Number(data) <= n) this.variant = Number(data) - 1;
    else return;
    // pgup/pgdn and toggles keep the scroll position; selection changes follow.
    this.follow = !matchesKey(data, "pageDown") && !matchesKey(data, "pageUp") && !" ts".includes(data);
  }

  private goSection(d: number): void {
    this.section = (this.section + d + SECTIONS.length) % SECTIONS.length;
    this.variant = 0;
    this.scroll = 0;
  }
}

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);
let timer: NodeJS.Timeout | undefined;
const quit = () => {
  if (timer) clearInterval(timer);
  tui.stop();
  process.stdout.write("\x1b[?1049l"); // leave the alternate screen: your scrollback comes back untouched
  const total = Object.values(picks).reduce((a, l) => a + l.length, 0);
  process.stdout.write(total ? `Saved ${String(total)} pick(s) to ${picksPath}\n` : "No picks saved.\n");
  process.exit(0);
};
const app = new Gallery(terminal, quit);
tui.addChild(app);
tui.setFocus(app);
process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
tui.start();
timer = setInterval(() => {
  app.frame += 1;
  tui.requestRender();
}, 80);
