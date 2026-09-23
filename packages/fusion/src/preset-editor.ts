/**
 * @pi-unipi/fusion — preset curation component (hub action "Edit fusion presets…")
 *
 * Two-column checklist over every available model:
 *
 *   Search: glm
 *   ─────────────────────────────────────────────────────
 *     L   S    model
 *   › [x][ ]  anthropic/claude-opus-4-6
 *     [ ][x]  omniroute/zai/glm-5.3-flash      ◆ active sidekick
 *     [ ][ ]  omniroute/deepseek/v4-flash
 *
 *   ↑/↓ select · ←/→ column · space toggle lead · Enter save · esc cancel · type to filter
 *
 * Keys follow our overlay conventions (task-manager dock, pi's own model
 * selector): arrows navigate, `Enter` is the primary action (save), `esc`
 * cancels, `tab`/`←→` switch the L/S column, `space` toggles membership.
 * Defaults are not edited here — confirming a Fusion pair in /unipi:model
 * records it as the default.
 */

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { frameOverlay } from "@pi-unipi/core";
import type { ActiveSelection, FusionPreset, ModelKey } from "./preset.js";

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
  /** Current selection — its pair becomes the default when still curated. */
  active: ActiveSelection | undefined;
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
  private target: "global" | "project";
  private search = "";
  private selected = 0;
  private column: "lead" | "sidekick" = "lead";
  private done = false;

  constructor(opts: PresetEditorOptions) {
    this.opts = opts;
    this.lead = new Set(opts.initial.lead);
    this.sidekick = new Set(opts.initial.sidekick);
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
    if (matchesKey(data, Key.enter) || data === "\r") {
      // Enter = save & close, the primary action in every other overlay.
      this.done = true;
      const lead = [...this.lead];
      const sidekick = [...this.sidekick];
      const def: FusionPreset["default"] = {};
      const active = this.opts.active;
      const dl =
        active?.kind === "fusion" && this.lead.has(active.lead)
          ? active.lead
          : this.opts.initial.default.lead !== undefined && this.lead.has(this.opts.initial.default.lead)
            ? this.opts.initial.default.lead
            : lead[0];
      const ds =
        active?.kind === "fusion" && this.sidekick.has(active.sidekick)
          ? active.sidekick
          : this.opts.initial.default.sidekick !== undefined && this.sidekick.has(this.opts.initial.default.sidekick)
            ? this.opts.initial.default.sidekick
            : sidekick[0];
      if (dl !== undefined) def.lead = dl;
      if (ds !== undefined) def.sidekick = ds;
      this.opts.onDone({ type: "saved", target: this.target, curation: { lead, sidekick, default: def } });
      return;
    }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, list.length - 1), this.selected + 1);
    else if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) this.column = "lead";
    else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) this.column = "sidekick";
    else if (data === " " && cur) this.toggle(this.column === "lead" ? this.lead : this.sidekick, cur.key);
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
    const active = this.opts.active;
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
      if (m.key === this.opts.initial.default.lead) tags.push("default lead");
      if (m.key === this.opts.initial.default.sidekick) tags.push("default sidekick");
      if (active?.kind === "fusion") {
        if (m.key === active.lead) tags.push("active lead");
        if (m.key === active.sidekick) tags.push("active sidekick");
      }
      const tag = tags.length > 0 ? ` ${t.fg("dim", `(${tags.join(", ")})`)}` : "";
      lines.push(truncateToWidth(` ${ptr} ${l} ${s}  ${name}${tag}`, Math.max(1, width - 1)));
    }
    if (list.length > win) lines.push(t.fg("dim", `  ${String(start + 1)}-${String(end)} of ${String(list.length)}`));
    lines.push("");
    lines.push(t.fg("dim", `↑/↓ select · ←/→|tab column · space toggle ${this.column} · enter save · esc cancel · type to filter`));
    return lines;
  }
}
