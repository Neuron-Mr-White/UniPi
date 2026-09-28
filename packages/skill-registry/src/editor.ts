/**
 * @pi-unipi/skill-registry — "Skill settings…" overlay (like Fusion's preset editor)
 *
 *   Skill settings · 47 skills · editing project · proxy on
 *   Search: (type to filter)
 *   ────────────────────────────────────────────────────────────
 *        E   D   M    skill                 source
 *   ›   [x] [x] [ ]   sql-review            user     Review SQL migrations…
 *       [ ] [x] [ ]   aws-deploy            vault    Deploy services to AWS…
 *
 *   E enabled — in the session; off blocks /skill:name
 *   D discoverable — listed in the system prompt
 *   M must show — always listed, even when judging would hide it
 *   ↑↓ skill · ←→ column · space toggle · d inherit · g scope · p proxy · enter save · esc cancel · type to filter
 *
 * Each cell shows the EFFECTIVE value; a value set in the layer being edited
 * is bright, an inherited one dim. Changes are held until Enter.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { frameOverlay } from "@pi-unipi/core";
import type { SkillSource } from "./registry.js";
import type { SkillState } from "./settings.js";

export type Column = "enabled" | "discoverable" | "mustShow";
export const COLUMNS: readonly Column[] = ["enabled", "discoverable", "mustShow"];
const LETTER: Record<Column, string> = { enabled: "E", discoverable: "D", mustShow: "M" };

export interface EditorSkill {
  name: string;
  description: string;
  source: SkillSource;
}

export type Scope = "global" | "project";
export type Layers = Record<Scope, Record<string, SkillState>>;

export interface EditorResult {
  type: "saved" | "cancelled";
  /** The layers as edited (only meaningful when saved). */
  layers: Layers;
  proxy: boolean;
}

export interface EditorOptions {
  skills: readonly EditorSkill[];
  layers: Layers;
  proxy: boolean;
  initialScope: Scope;
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };
  onDone: (result: EditorResult) => void;
  onRenderRequest?: () => void;
  visibleRows?: number;
}

function defaultFor(column: Column, source: SkillSource): boolean {
  if (column === "enabled") return source !== "vault";
  return column === "discoverable";
}

/** Effective value of one cell: project over global over the source default. */
export function cellValue(layers: Layers, skill: EditorSkill, column: Column): { value: boolean; from: Scope | "default" } {
  const p = layers.project[skill.name]?.[column];
  if (typeof p === "boolean") return { value: p, from: "project" };
  const g = layers.global[skill.name]?.[column];
  if (typeof g === "boolean") return { value: g, from: "global" };
  return { value: defaultFor(column, skill.source), from: "default" };
}

function printable(data: string): string | undefined {
  if (data.length !== 1) return undefined;
  const code = data.charCodeAt(0);
  return code < 32 || code === 127 ? undefined : data;
}

export class SkillEditor {
  private readonly opts: EditorOptions;
  private readonly layers: Layers;
  private proxy: boolean;
  private scope: Scope;
  private search = "";
  private selected = 0;
  private column = 0;
  private done = false;

  constructor(opts: EditorOptions) {
    this.opts = opts;
    this.layers = { global: structuredClone(opts.layers.global), project: structuredClone(opts.layers.project) };
    this.proxy = opts.proxy;
    this.scope = opts.initialScope;
  }

  private filtered(): EditorSkill[] {
    const q = this.search.toLowerCase();
    const list = q ? this.opts.skills.filter((s) => `${s.name} ${s.source} ${s.description}`.toLowerCase().includes(q)) : [...this.opts.skills];
    return list;
  }

  handleInput(data: string): void {
    if (this.done) return;
    const list = this.filtered();
    const cur = list[this.selected];
    const col = COLUMNS[this.column]!;
    if (matchesKey(data, Key.escape)) {
      if (this.search) {
        this.search = "";
        this.selected = 0;
      } else {
        this.done = true;
        this.opts.onDone({ type: "cancelled", layers: this.layers, proxy: this.proxy });
        return;
      }
    } else if (matchesKey(data, Key.enter) || data === "\r") {
      this.done = true;
      this.opts.onDone({ type: "saved", layers: this.layers, proxy: this.proxy });
      return;
    } else if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, list.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) this.column = (this.column + COLUMNS.length - 1) % COLUMNS.length;
    else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.column = (this.column + 1) % COLUMNS.length;
    else if (matchesKey(data, Key.pageUp)) this.selected = Math.max(0, this.selected - this.window());
    else if (matchesKey(data, Key.pageDown)) this.selected = Math.min(Math.max(0, list.length - 1), this.selected + this.window());
    else if ((data === " " || matchesKey(data, Key.space)) && cur) {
      const next = !cellValue(this.layers, cur, col).value;
      const layer = this.layers[this.scope];
      layer[cur.name] = { ...layer[cur.name], [col]: next };
    } else if (!this.search && data === "d" && cur) {
      const entry = this.layers[this.scope][cur.name];
      if (entry) {
        delete entry[col];
        if (Object.keys(entry).length === 0) delete this.layers[this.scope][cur.name];
      }
    } else if (!this.search && data === "g") this.scope = this.scope === "global" ? "project" : "global";
    else if (!this.search && data === "p") this.proxy = !this.proxy;
    else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.search = this.search.slice(0, -1);
      this.selected = 0;
    } else {
      const ch = printable(data);
      if (ch === undefined || ch === " ") return;
      this.search += ch;
      this.selected = 0;
    }
    this.opts.onRenderRequest?.();
  }

  private window(): number {
    return this.opts.visibleRows ?? Math.max(5, Math.min(18, (process.stdout.rows ?? 40) - 16));
  }

  invalidate(): void {}

  render(width: number): string[] {
    return frameOverlay(this.body(Math.max(20, width - 2)), width, { title: "Skill settings" });
  }

  private body(width: number): string[] {
    const t = this.opts.theme;
    const list = this.filtered();
    if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
    const fit = (s: string) => truncateToWidth(s, Math.max(1, width - 1));
    const lines: string[] = [];
    lines.push(fit(`${t.fg("accent", t.bold("Skill settings"))} ${t.fg("dim", `· ${list.length} skills · editing `)}${t.fg("accent", this.scope)}${t.fg("dim", " · proxy ")}${this.proxy ? t.fg("success", "on") : t.fg("warning", "off — saved but not applied (p)")}`));
    lines.push(fit(`${t.fg("dim", "Search:")} ${this.search ? t.fg("text", this.search) : t.fg("dim", "(type to filter)")}`));
    lines.push(t.fg("dim", "─".repeat(Math.max(1, width - 2))));

    const nameW = Math.min(28, Math.max(10, ...list.map((s) => s.name.length)) + 1);
    const head = COLUMNS.map((c, i) => (i === this.column ? t.fg("accent", t.bold(` ${LETTER[c]} `)) : t.fg("dim", ` ${LETTER[c]} `))).join(" ");
    lines.push(fit(`   ${head}   ${t.fg("dim", "skill".padEnd(nameW))} ${t.fg("dim", "source ")} ${t.fg("dim", "description")}`));

    const win = this.window();
    const start = Math.max(0, Math.min(this.selected - Math.floor(win / 2), list.length - win));
    const end = Math.min(list.length, start + win);
    if (list.length === 0) lines.push(t.fg("warning", "  No skills match."));
    if (start > 0) lines.push(t.fg("dim", `  ↑ ${start} more`));
    for (let i = start; i < end; i++) {
      const s = list[i]!;
      const hl = i === this.selected;
      const cells = COLUMNS.map((c, ci) => {
        const { value, from } = cellValue(this.layers, s, c);
        const glyph = value ? "[x]" : "[ ]";
        if (hl && ci === this.column) return t.fg("accent", t.bold(glyph));
        if (from === this.scope) return value ? t.fg("success", glyph) : t.fg("text", glyph);
        return t.fg("dim", glyph);
      }).join(" ");
      const name = s.name.length > nameW - 1 ? `${s.name.slice(0, nameW - 2)}…` : s.name;
      const label = hl ? t.fg("accent", name.padEnd(nameW)) : t.fg("text", name.padEnd(nameW));
      const src = t.fg(s.source === "vault" ? "warning" : "dim", s.source.padEnd(7));
      const desc = t.fg("dim", s.description.replace(/\s+/g, " "));
      lines.push(fit(` ${hl ? t.fg("accent", "›") : " "} ${cells}   ${label} ${src} ${desc}`));
    }
    if (end < list.length) lines.push(t.fg("dim", `  ↓ ${list.length - end} more`));

    lines.push("");
    const legend: Array<[Column, string]> = [
      ["enabled", "enabled — in the session; off blocks /skill:name"],
      ["discoverable", "discoverable — listed in the system prompt"],
      ["mustShow", "must show — always listed, even when judging would hide it"],
    ];
    for (const [c, text] of legend) {
      const active = COLUMNS[this.column] === c;
      lines.push(fit(`${active ? t.fg("accent", t.bold(LETTER[c])) : t.fg("dim", LETTER[c])} ${active ? t.fg("text", text) : t.fg("dim", text)}`));
    }
    lines.push(fit(t.fg("dim", `bright = set in ${this.scope} · dim = inherited`)));
    lines.push(fit(t.fg("dim", "↑↓ skill · ←→ column · space toggle · d inherit · g scope · p proxy · enter save · esc cancel · type to filter")));
    return lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
  }
}
