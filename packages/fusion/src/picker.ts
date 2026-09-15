/**
 * @pi-unipi/fusion — Devin-style model picker component
 *
 * Layout (learned from Devin CLI `/model`, not copied):
 *
 *   / type to search
 *   ──────────────────────────────────────────────────────────────
 *   ❭ Fusion              ← ◼◼◼◼◻ → High     Lead Opus… ▾  Sidekick GLM… ▾
 *   · GLM-5.3 Flash ✓       ◼◼◼◼◼     Max
 *   · Claude Opus 5         ◼◼◼       Medium
 *     ↓ more below
 *
 *   Input      Cached input   Output     Sidekick input  Sidekick output
 *   $10 / 1M   $0.25 / 1M     $50 / 1M   $0.2 / 1M       $1.2 / 1M
 *   ↑/↓ select · ←/→ effort · tab lead · Enter confirm · esc cancel
 *
 * Row order: the active selection pinned first, then the Fusion row (when a
 * pair is configured), then recent (≤5, MRU), then the preset models, then
 * EVERY other available model — the catalogue is never hidden, the preset
 * only controls ordering. Typing filters all rows except the pinned one.
 *
 * ←/→ steps the highlighted row's effort. Per-model effort is remembered for
 * plain model rows; the Fusion row keeps its own lead/sidekick efforts so
 * adjusting one never rewrites a model's standalone level.
 *
 * When a single model is selected, its row lights up with ✓ (plus accent
 * styling). When Fusion is selected, the selection lives on the Fusion row
 * only — plain model rows stay unmarked.
 *
 * On the Fusion row, Tab cycles effort → lead → sidekick (Shift+Tab
 * reverses); the lead/sidekick focus opens an inline dropdown fed by the
 * preset lists.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { frameOverlay } from "@pi-unipi/core";
import {
  effortLabel,
  EFFORT_LEVELS,
  stepEffort,
  type ActiveSelection,
  type EffortLevel,
  type FusionBadge,
  type ModelKey,
} from "./preset.js";
import { blendedPrice, renderSlider, sliderPosition } from "./slider.js";

// ── Data contracts ─────────────────────────────────────────────────────────

export interface PickerModel {
  key: ModelKey;
  name: string;
  provider: string;
  badge?: FusionBadge | undefined;
  /** $/1M tokens; undefined when the catalogue has no price. */
  cost?: { input: number; cachedInput: number; output: number } | undefined;
  reasoning: boolean;
}

export interface PickerState {
  models: readonly PickerModel[];
  fusionLeads: readonly ModelKey[];
  fusionSidekicks: readonly ModelKey[];
  fusionDefault: { lead?: ModelKey | undefined; sidekick?: ModelKey | undefined };
  recent: readonly ModelKey[];
  active: ActiveSelection | undefined;
  /** The session's current model — its row lights up with ✓. */
  currentModelKey: ModelKey | undefined;
  effort: Readonly<Record<ModelKey, EffortLevel>>;
  /** Effort used for a model with no remembered level. */
  fallbackEffort: EffortLevel;
}

export type PickerResult =
  | {
      type: "single";
      model: ModelKey;
      effort: EffortLevel;
      effortMap: Record<ModelKey, EffortLevel>;
    }
  | {
      type: "fusion";
      lead: ModelKey;
      sidekick: ModelKey;
      leadEffort: EffortLevel;
      sidekickEffort: EffortLevel;
      effortMap: Record<ModelKey, EffortLevel>;
    }
  | { type: "cancelled" };

export interface PickerTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export interface PickerOptions {
  state: PickerState;
  theme: PickerTheme;
  onDone: (result: PickerResult) => void;
  onRenderRequest?: (() => void) | undefined;
  /** Rows visible in the list window. */
  visibleRows?: number | undefined;
}

// ── Rows ───────────────────────────────────────────────────────────────────

type Row = { kind: "fusion" } | { kind: "model"; key: ModelKey };
type FusionFocus = "effort" | "lead" | "sidekick";

const DEFAULT_VISIBLE_ROWS = 10;
const NAME_COL = 24;
const MARKER_COL = 2;
const BAR_SEGMENTS = 5;

function printable(data: string): string | undefined {
  if (data.length !== 1) return undefined;
  const code = data.charCodeAt(0);
  if (code < 32 || code === 127) return undefined;
  return data;
}

function shortName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, Math.max(1, max - 1))}…` : name;
}

function money(perMillion: number): string {
  const rounded = perMillion >= 10 ? perMillion.toFixed(0) : perMillion >= 1 ? perMillion.toFixed(1) : perMillion.toFixed(2);
  return `$${rounded.replace(/\.0+$/u, "").replace(/(\.\d)0$/u, "$1")} / 1M`;
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

export class ModelPicker {
  private readonly theme: PickerTheme;
  private readonly onDone: (result: PickerResult) => void;
  private readonly onRenderRequest: (() => void) | undefined;
  private readonly visibleRows: number;
  private readonly modelsByKey: Map<ModelKey, PickerModel>;
  private readonly state: PickerState;
  private readonly priceRange: { min: number; max: number };

  private effort: Record<ModelKey, EffortLevel>;
  /** Fusion-row efforts — deliberately NOT stored in the per-model map. */
  private fusionLeadEffort: EffortLevel;
  private fusionSidekickEffort: EffortLevel;
  private lead: ModelKey | undefined;
  private sidekick: ModelKey | undefined;
  private search = "";
  private selected = 0;
  private focus: FusionFocus = "effort";
  private dropdownIndex = 0;
  private done = false;

  constructor(options: PickerOptions) {
    this.state = options.state;
    this.theme = options.theme;
    this.onDone = options.onDone;
    this.onRenderRequest = options.onRenderRequest;
    this.visibleRows = options.visibleRows ?? DEFAULT_VISIBLE_ROWS;
    this.modelsByKey = new Map(options.state.models.map((m) => [m.key, m]));
    const prices = options.state.models.map((m) => (m.cost ? blendedPrice(m.cost) : undefined)).filter((p): p is number => p !== undefined);
    this.priceRange = { min: prices.length > 0 ? Math.min(...prices) : 0, max: prices.length > 0 ? Math.max(...prices) : 0 };
    this.effort = { ...options.state.effort };
    const active = options.state.active;
    this.lead =
      (active?.kind === "fusion" ? active.lead : undefined) ??
      options.state.fusionDefault.lead ??
      options.state.fusionLeads[0];
    this.sidekick =
      (active?.kind === "fusion" ? active.sidekick : undefined) ??
      options.state.fusionDefault.sidekick ??
      options.state.fusionSidekicks[0];
    this.fusionLeadEffort =
      (active?.kind === "fusion" ? active.leadEffort : undefined) ??
      (this.lead !== undefined ? this.effort[this.lead] : undefined) ??
      options.state.fallbackEffort;
    this.fusionSidekickEffort =
      (active?.kind === "fusion" ? active.sidekickEffort : undefined) ??
      (this.sidekick !== undefined ? this.effort[this.sidekick] : undefined) ??
      options.state.fallbackEffort;
    this.selected = 0; // pinned active row
  }

  // ── Row model ────────────────────────────────────────────────────────────

  private fusionAvailable(): boolean {
    return this.lead !== undefined && this.sidekick !== undefined;
  }

  private matchesSearch(key: ModelKey): boolean {
    if (this.search.length === 0) return true;
    const m = this.modelsByKey.get(key);
    const hay = `${key} ${m?.name ?? ""}`.toLowerCase();
    const q = this.search.toLowerCase();
    // subsequence match, cheap and forgiving
    let i = 0;
    for (const ch of hay) {
      if (ch === q[i]) i++;
      if (i === q.length) return true;
    }
    return q.length === 0;
  }

  rows(): Row[] {
    const out: Row[] = [];
    const seen = new Set<ModelKey>();
    const active = this.state.active;
    const pinnedFusion = active?.kind === "fusion" && this.fusionAvailable();

    if (pinnedFusion) out.push({ kind: "fusion" });
    else if (active?.kind === "single" && this.modelsByKey.has(active.model)) {
      out.push({ kind: "model", key: active.model });
      seen.add(active.model);
    }
    if (!pinnedFusion && this.fusionAvailable()) out.push({ kind: "fusion" });

    const ordered: ModelKey[] = [
      ...this.state.recent,
      ...this.state.fusionLeads,
      ...this.state.fusionSidekicks,
    ];
    // The whole catalogue always follows; the preset only controls ordering.
    ordered.push(...this.state.models.map((m) => m.key));
    for (const key of ordered) {
      if (seen.has(key) || !this.modelsByKey.has(key)) continue;
      if (!this.matchesSearch(key)) continue;
      seen.add(key);
      out.push({ kind: "model", key });
    }
    return out;
  }

  private effortFor(key: ModelKey | undefined): EffortLevel {
    if (key === undefined) return this.state.fallbackEffort;
    return this.effort[key] ?? this.state.fallbackEffort;
  }

  private selectedRow(): Row | undefined {
    return this.rows()[this.selected];
  }

  private dropdownItems(): ModelKey[] {
    const source = this.focus === "lead" ? this.state.fusionLeads : this.state.fusionSidekicks;
    return source.filter((k) => this.modelsByKey.has(k));
  }

  // ── Input ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.done) return;
    const row = this.selectedRow();
    const inDropdown = row?.kind === "fusion" && this.focus !== "effort";

    if (matchesKey(data, Key.escape)) {
      if (inDropdown) {
        this.focus = "effort";
        this.changed();
        return;
      }
      this.finish({ type: "cancelled" });
      return;
    }

    if (inDropdown) {
      const items = this.dropdownItems();
      if (matchesKey(data, Key.up)) {
        this.dropdownIndex = Math.max(0, this.dropdownIndex - 1);
      } else if (matchesKey(data, Key.down)) {
        this.dropdownIndex = Math.min(Math.max(0, items.length - 1), this.dropdownIndex + 1);
      } else if (matchesKey(data, Key.tab)) {
        this.applyDropdown(items);
        this.cycleFocus(matchesKey(data, "shift+tab"));
      } else if (matchesKey(data, Key.enter) || data === "\r") {
        this.applyDropdown(items);
        this.focus = "effort";
      } else {
        return;
      }
      this.changed();
      return;
    }

    if (matchesKey(data, Key.up)) {
      const n = this.rows().length;
      this.selected = n === 0 ? 0 : (this.selected - 1 + n) % n;
      this.focus = "effort";
    } else if (matchesKey(data, Key.down)) {
      const n = this.rows().length;
      this.selected = n === 0 ? 0 : (this.selected + 1) % n;
      this.focus = "effort";
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const delta: -1 | 1 = matchesKey(data, Key.left) ? -1 : 1;
      if (row?.kind === "fusion") {
        // Fusion-row effort is its own state: never touches per-model memory.
        if (this.focus === "effort") this.fusionLeadEffort = stepEffort(this.fusionLeadEffort, delta);
      } else if (row?.key !== undefined) {
        this.effort[row.key] = stepEffort(this.effortFor(row.key), delta);
      }
    } else if (matchesKey(data, Key.tab)) {
      if (row?.kind === "fusion") this.cycleFocus(matchesKey(data, "shift+tab"));
    } else if (matchesKey(data, Key.enter) || data === "\r") {
      this.confirm(row);
      return;
    } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.search = this.search.slice(0, -1);
      this.selected = 0;
    } else {
      const ch = printable(data);
      if (ch === undefined) return;
      this.search += ch;
      this.selected = 0;
    }
    this.changed();
  }

  private cycleFocus(reverse = false): void {
    const order: FusionFocus[] = ["effort", "lead", "sidekick"];
    const dir = reverse ? -1 : 1;
    const next = order[(order.indexOf(this.focus) + dir + order.length) % order.length] ?? "effort";
    this.focus = next;
    if (this.focus !== "effort") {
      const items = this.dropdownItems();
      const current = this.focus === "lead" ? this.lead : this.sidekick;
      const idx = current === undefined ? -1 : items.indexOf(current);
      this.dropdownIndex = idx >= 0 ? idx : 0;
    }
  }

  private applyDropdown(items: ModelKey[]): void {
    const pick = items[this.dropdownIndex];
    if (pick === undefined) return;
    if (this.focus === "lead") this.lead = pick;
    else this.sidekick = pick;
  }

  private confirm(row: Row | undefined): void {
    if (row === undefined) return;
    if (row.kind === "fusion") {
      if (this.lead === undefined || this.sidekick === undefined) return;
      this.finish({
        type: "fusion",
        lead: this.lead,
        sidekick: this.sidekick,
        leadEffort: this.fusionLeadEffort,
        sidekickEffort: this.fusionSidekickEffort,
        effortMap: { ...this.effort },
      });
      return;
    }
    this.finish({
      type: "single",
      model: row.key,
      effort: this.effortFor(row.key),
      effortMap: { ...this.effort },
    });
  }

  private finish(result: PickerResult): void {
    this.done = true;
    this.onDone(result);
  }

  private changed(): void {
    this.onRenderRequest?.();
  }

  invalidate(): void {
    /* stateless render */
  }

  // ── Render ───────────────────────────────────────────────────────────────

  /**
   * Marker for the working model. Only a SINGLE active selection gets a ✓ —
   * when Fusion is selected, the selection lives on the Fusion row itself and
   * plain model rows stay unmarked.
   */
  private markerFor(key: ModelKey | undefined): string {
    if (key === undefined) return " ";
    const active = this.state.active;
    if (active?.kind === "single" && key === active.model) return this.theme.fg("success", "✓");
    return " ";
  }

  private bar(level: EffortLevel, highlighted: boolean): string {
    const index = Math.max(0, EFFORT_LEVELS.indexOf(level));
    const filled = Math.ceil((index / (EFFORT_LEVELS.length - 1)) * BAR_SEGMENTS);
    const on = this.theme.fg(highlighted ? "text" : "muted", "▰".repeat(filled));
    const off = this.theme.fg("dim", "▱".repeat(BAR_SEGMENTS - filled));
    return `${on}${off}`;
  }

  private nameOf(key: ModelKey | undefined, max: number): string {
    if (key === undefined) return "—";
    const m = this.modelsByKey.get(key);
    return shortName(m?.name ?? key, max);
  }

  private renderRow(row: Row, highlighted: boolean, width: number): string {
    const t = this.theme;
    const pointer = highlighted ? t.fg("accent", "❭") : t.fg("dim", "·");
    // The Fusion composite gets the check when it is the active selection —
    // same affordance a single active model gets on its own row.
    const marker =
      row.kind === "fusion"
        ? this.state.active?.kind === "fusion"
          ? t.fg("success", "✓")
          : " "
        : this.markerFor(row.key);
    const working = row.kind === "model" && row.key === this.state.currentModelKey;
    const nameRaw = row.kind === "fusion" ? "Fusion" : this.nameOf(row.key, NAME_COL - 1);
    const name =
      row.kind === "fusion"
        ? highlighted
          ? t.fg("accent", t.bold(nameRaw))
          : t.fg("text", nameRaw)
        : working
          ? t.fg("accent", t.bold(nameRaw))
          : highlighted
            ? t.fg("accent", nameRaw)
            : t.fg("text", nameRaw);
    const model = row.kind === "model" ? this.modelsByKey.get(row.key) : undefined;
    const badge = model?.badge;
    const badgeGlyph = badge === undefined ? "" : ` ${t.fg(badge === "new" ? "success" : badge === "promotion" ? "accent" : "warning", "✱")}`;

    const level = row.kind === "fusion" ? this.fusionLeadEffort : this.effortFor(row.key);
    const arrowsOn = highlighted && this.focus === "effort";
    const left = arrowsOn ? t.fg("accent", "←") : " ";
    const right = arrowsOn ? t.fg("accent", "→") : " ";
    const label = highlighted ? t.fg("accent", effortLabel(level)) : t.fg("muted", effortLabel(level));

    let line = `${pointer} ${marker} ${pad(`${name}${badgeGlyph}`, NAME_COL)} ${left} ${this.bar(level, highlighted)} ${right} ${pad(label, 8)}`;

    if (row.kind === "fusion") {
      const leadName = this.nameOf(this.lead, 14);
      const sideName = this.nameOf(this.sidekick, 14);
      const leadFocused = highlighted && this.focus === "lead";
      const sideFocused = highlighted && this.focus === "sidekick";
      const leadText = leadFocused
        ? `${t.fg("accent", t.bold("Lead"))} ${t.fg("accent", leadName)} ${t.fg("accent", "▾")}`
        : `${t.fg("dim", "Lead")} ${t.fg("text", leadName)} ${t.fg("dim", "▾")}`;
      const sideText = sideFocused
        ? `${t.fg("accent", t.bold("Sidekick"))} ${t.fg("accent", sideName)} ${t.fg("accent", "▾")}`
        : `${t.fg("dim", "Sidekick")} ${t.fg("text", sideName)} ${t.fg("dim", "▾")}`;
      line += `   ${leadText}   ${sideText}`;
    }
    return truncateToWidth(line, Math.max(1, width - 1));
  }

  private renderDropdown(width: number): string[] {
    const t = this.theme;
    const items = this.dropdownItems();
    const indent = " ".repeat(MARKER_COL + NAME_COL + 5);
    if (items.length === 0) {
      return [`${indent}${t.fg("warning", `no ${this.focus} models in preset — run /unipi:fusion-preset`)}`];
    }
    const win = 6;
    const start = Math.max(0, Math.min(this.dropdownIndex - Math.floor(win / 2), items.length - win));
    const slice = items.slice(start, start + win);
    return slice.map((key, i) => {
      const idx = start + i;
      const isCur = idx === this.dropdownIndex;
      const isSet = key === (this.focus === "lead" ? this.lead : this.sidekick);
      const glyph = isCur ? t.fg("accent", "▸") : " ";
      const label = isCur ? t.fg("accent", t.bold(this.nameOf(key, 28))) : t.fg("text", this.nameOf(key, 28));
      const star = isSet ? t.fg("dim", " *") : "";
      return truncateToWidth(`${indent}${glyph} ${label}${star}`, Math.max(1, width - 1));
    });
  }

  private renderPricePanel(row: Row | undefined, width: number): string[] {
    const t = this.theme;
    if (row === undefined) return [];
    const primaryKey = row.kind === "fusion" ? this.lead : row.key;
    const primary = primaryKey === undefined ? undefined : this.modelsByKey.get(primaryKey);
    const side = row.kind === "fusion" && this.sidekick !== undefined ? this.modelsByKey.get(this.sidekick) : undefined;
    const cols: Array<[string, string]> = [];
    if (primary?.cost) {
      cols.push(["Input", money(primary.cost.input)]);
      cols.push(["Cached input", money(primary.cost.cachedInput)]);
      cols.push(["Output", money(primary.cost.output)]);
    } else {
      cols.push(["Input", "—"], ["Cached input", "—"], ["Output", "—"]);
    }
    if (row.kind === "fusion") {
      if (side?.cost) {
        cols.push(["Sidekick input", money(side.cost.input)]);
        cols.push(["Sidekick cached input", money(side.cost.cachedInput)]);
        cols.push(["Sidekick output", money(side.cost.output)]);
      } else {
        cols.push(["Sidekick input", "—"], ["Sidekick cached input", "—"], ["Sidekick output", "—"]);
      }
    }
    const colWidth = Math.max(10, Math.min(18, Math.floor((width - 4) / cols.length)));
    const head = cols.map(([h]) => pad(t.fg("dim", h), colWidth)).join("");
    const vals = cols.map(([, v]) => pad(t.fg("text", v), colWidth)).join("");
    const desc =
      row.kind === "fusion"
        ? t.fg("dim", "Pairs frontier intelligence with cost-efficient execution")
        : primary?.reasoning
          ? t.fg("dim", "Reasoning model · ←/→ adjusts thinking effort")
          : t.fg("dim", "Non-reasoning model · effort is ignored by the provider");
    const badges = this.state.models.some((m) => m.badge !== undefined)
      ? `${t.fg("success", "✱")} ${t.fg("dim", "New")}  ${t.fg("accent", "✱")} ${t.fg("dim", "Promotion")}  ${t.fg("warning", "✱")} ${t.fg("dim", "Beta")} ${t.fg("dim", "·")}`
      : "";
    const description = `${badges}${badges.length > 0 ? " " : ""}${desc}`;
    return [truncateToWidth(`  ${head}`, width - 1), truncateToWidth(`  ${vals}`, width - 1), truncateToWidth(`  ${description}`, width - 1)];
  }

  private hintLine(row: Row | undefined): string {
    const t = this.theme;
    const parts: string[] = [];
    if (row?.kind === "fusion" && this.focus !== "effort") {
      parts.push("↑↓ select", `tab ${this.focus === "lead" ? "sidekick" : "effort"}`, "↵ apply", "esc collapse");
    } else {
      parts.push("↑↓ select");
      if (row?.kind === "fusion") parts.push("tab lead");
      parts.push("←→ effort", "↵ confirm", "esc cancel");
    }
    return t.fg("dim", parts.join(" · "));
  }

  render(width: number): string[] {
    return frameOverlay(this.renderBody(Math.max(4, width - 2)), width, { title: "Model" });
  }

  private renderBody(width: number): string[] {
    const t = this.theme;
    const rows = this.rows();
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
    const row = rows[this.selected];
    const lines: string[] = [];

    const searchText = this.search.length > 0 ? t.fg("text", this.search) : t.fg("dim", "Type to search");
    lines.push(truncateToWidth(`${t.fg("accent", "/")} ${searchText}`, width - 1));
    lines.push(t.fg("dim", "─".repeat(Math.max(1, width - 2))));

    if (rows.length === 0) {
      lines.push(t.fg("warning", "  No matching models."));
    } else {
      const win = this.visibleRows;
      const start = Math.max(0, Math.min(this.selected - Math.floor(win / 2), rows.length - win));
      const end = Math.min(rows.length, start + win);
      if (start > 0) lines.push(t.fg("dim", "  ↑ more above"));
      for (let i = start; i < end; i++) {
        const r = rows[i];
        if (r === undefined) continue;
        const highlighted = i === this.selected;
        lines.push(this.renderRow(r, highlighted, width));
        if (highlighted && r.kind === "fusion" && this.focus !== "effort") {
          lines.push(...this.renderDropdown(width));
        }
      }
      if (end < rows.length) lines.push(t.fg("dim", `  ↓ more below (${String(rows.length - end)})`));
    }

    lines.push("");
    const sliderCells = Math.min(48, Math.max(1, width - 6));
    const sliderKey = row?.kind === "fusion" ? this.lead : row?.key;
    const sliderModel = sliderKey === undefined ? undefined : this.modelsByKey.get(sliderKey);
    const sliderPrice = sliderModel?.cost === undefined ? undefined : blendedPrice(sliderModel.cost);
    const marker = sliderPrice === undefined ? undefined : sliderPosition(sliderPrice, this.priceRange.min, this.priceRange.max, sliderCells);
    lines.push(truncateToWidth(`  ${renderSlider(sliderCells, marker)}`, width - 1));
    lines.push(...this.renderPricePanel(row, width));
    lines.push("");
    lines.push(this.hintLine(row));
    return lines;
  }
}
