/**
 * @pi-unipi/fusion — `/unipi:fusion-preset` curation component
 *
 * Two-column checklist over every available model:
 *
 *   Search: gl
 *   ─────────────────────────────────────────────────────
 *     L  S   model
 *   › [x][ ]  anthropic/claude-opus-4-6        (default lead)
 *     [ ][x]  omniroute/zai/glm-5.3-flash      (default sidekick)
 *     [ ][ ]  omniroute/deepseek/v4-flash
 *
 *   ↑↓ move · ←→ column · space toggle · ↵ set default · ctrl+y save · ctrl+w target · esc cancel
 *   (typing filters — every printable key goes to the search box)
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { frameOverlay } from "@pi-unipi/core";
import type { FusionPreset, ModelKey } from "./preset.js";

export interface PresetEditorModel {
  key: ModelKey;
  name: string;
}

export type PresetEditorResult =
  | {
      type: "saved";
      target: "global" | "project";
      curation: Pick<FusionPreset, "lead" | "sidekick" | "default">;
    }
  | { type: "cancelled" };

export interface PresetEditorOptions {
  models: readonly PresetEditorModel[];
  initial: Pick<FusionPreset, "lead" | "sidekick" | "default">;
  initialTarget: "global" | "project";
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };
  onDone: (result: PresetEditorResult) => void;
  onRenderRequest?: (() => void) | undefined;
  visibleRows?: number | undefined;
}

function printable(data: string): string | undefined {
  if (data.length !== 1) return undefined;
  const code = data.charCodeAt(0);
  if (code < 32 || code === 127) return undefined;
  return data;
}

export class PresetEditor {
  private readonly opts: PresetEditorOptions;
  private lead: Set<ModelKey>;
  private sidekick: Set<ModelKey>;
  private defaultLead: ModelKey | undefined;
  private defaultSidekick: ModelKey | undefined;
  private target: "global" | "project";
  private search = "";
  private selected = 0;
  private column: "lead" | "sidekick" = "lead";
  private done = false;

  constructor(opts: PresetEditorOptions) {
    this.opts = opts;
    this.lead = new Set(opts.initial.lead);
    this.sidekick = new Set(opts.initial.sidekick);
    this.defaultLead = opts.initial.default.lead;
    this.defaultSidekick = opts.initial.default.sidekick;
    this.target = opts.initialTarget;
  }

  private filtered(): PresetEditorModel[] {
    const q = this.search.toLowerCase();
    const all = this.opts.models;
    const list = q.length === 0 ? [...all] : all.filter((m) => `${m.key} ${m.name}`.toLowerCase().includes(q));
    // Selected models float to the top so the curated set is visible at a glance.
    list.sort((a, b) => {
      const sa = this.lead.has(a.key) || this.sidekick.has(a.key) ? 0 : 1;
      const sb = this.lead.has(b.key) || this.sidekick.has(b.key) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return a.key.localeCompare(b.key);
    });
    return list;
  }

  handleInput(data: string): void {
    if (this.done) return;
    const list = this.filtered();
    const cur = list[this.selected];
    if (matchesKey(data, Key.escape)) {
      this.done = true;
      this.opts.onDone({ type: "cancelled" });
      return;
    }
    if (matchesKey(data, "ctrl+y") || data === "\x13") {
      // ctrl+y — save (matchesKey handles both raw ^Y and kitty CSI-u)
      this.done = true;
      const lead = [...this.lead];
      const sidekick = [...this.sidekick];
      const def: FusionPreset["default"] = {};
      const dl = this.defaultLead !== undefined && this.lead.has(this.defaultLead) ? this.defaultLead : lead[0];
      const ds = this.defaultSidekick !== undefined && this.sidekick.has(this.defaultSidekick) ? this.defaultSidekick : sidekick[0];
      if (dl !== undefined) def.lead = dl;
      if (ds !== undefined) def.sidekick = ds;
      this.opts.onDone({ type: "saved", target: this.target, curation: { lead, sidekick, default: def } });
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, list.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.left)) this.column = "lead";
    else if (matchesKey(data, Key.right)) this.column = "sidekick";
    else if (matchesKey(data, Key.tab)) this.column = this.column === "lead" ? "sidekick" : "lead";
    else if (data === " " && cur) this.toggle(this.column === "lead" ? this.lead : this.sidekick, cur.key);
    else if ((matchesKey(data, Key.enter) || data === "\r") && cur) {
      // enter — make the highlighted model the default for the focused column
      if (this.column === "lead") {
        this.lead.add(cur.key);
        this.defaultLead = cur.key;
      } else {
        this.sidekick.add(cur.key);
        this.defaultSidekick = cur.key;
      }
    } else if (matchesKey(data, "ctrl+w")) this.target = this.target === "global" ? "project" : "global";
    else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.search = this.search.slice(0, -1);
      this.selected = 0;
    } else {
      const ch = printable(data);
      if (ch === undefined) return;
      this.search += ch;
      this.selected = 0;
    }
    this.opts.onRenderRequest?.();
  }

  private toggle(set: Set<ModelKey>, key: ModelKey): void {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return frameOverlay(this.renderBody(Math.max(4, width - 2)), width, { title: "Fusion preset" });
  }

  private renderBody(width: number): string[] {
    const t = this.opts.theme;
    const list = this.filtered();
    if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
    const lines: string[] = [];
    lines.push(`${t.fg("accent", t.bold("Fusion preset"))} ${t.fg("dim", `· ${String(this.lead.size)} lead · ${String(this.sidekick.size)} sidekick · writes to ${this.target}`)}`);
    lines.push(`${t.fg("dim", "Search:")} ${this.search.length > 0 ? t.fg("text", this.search) : t.fg("dim", "(type to filter)")}`);
    lines.push(t.fg("dim", "─".repeat(Math.max(1, width - 2))));
    const colHead = (label: string, col: "lead" | "sidekick") =>
      this.column === col ? t.fg("accent", t.bold(label)) : t.fg("dim", label);
    lines.push(`    ${colHead("L", "lead")}   ${colHead("S", "sidekick")}    ${t.fg("dim", "model")}`);
    const win = this.opts.visibleRows ?? 14;
    const start = Math.max(0, Math.min(this.selected - Math.floor(win / 2), list.length - win));
    const end = Math.min(list.length, start + win);
    if (list.length === 0) lines.push(t.fg("warning", "  No models match."));
    for (let i = start; i < end; i++) {
      const m = list[i];
      if (!m) continue;
      const hl = i === this.selected;
      const ptr = hl ? t.fg("accent", "›") : " ";
      const box = (on: boolean, col: "lead" | "sidekick") => {
        const focused = hl && this.column === col;
        const glyph = on ? "[x]" : "[ ]";
        return focused ? t.fg("accent", t.bold(glyph)) : on ? t.fg("success", glyph) : t.fg("dim", glyph);
      };
      const l = box(this.lead.has(m.key), "lead");
      const s = box(this.sidekick.has(m.key), "sidekick");
      const name = hl ? t.fg("accent", m.key) : t.fg("text", m.key);
      const tags: string[] = [];
      if (m.key === this.defaultLead) tags.push("default lead");
      if (m.key === this.defaultSidekick) tags.push("default sidekick");
      const tag = tags.length > 0 ? ` ${t.fg("dim", `(${tags.join(", ")})`)}` : "";
      lines.push(truncateToWidth(` ${ptr} ${l} ${s}  ${name}${tag}`, Math.max(1, width - 1)));
    }
    if (list.length > win) lines.push(t.fg("dim", `  ${String(start + 1)}-${String(end)} of ${String(list.length)}`));
    lines.push("");
    lines.push(t.fg("dim", `↑↓ move · ←→ column · space toggle ${this.column} · ↵ default ${this.column} · ^Y save · ^W target · esc cancel · type to filter`));
    return lines;
  }
}
