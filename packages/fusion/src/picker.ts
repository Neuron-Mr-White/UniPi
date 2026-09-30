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
 * Row order: the active selection pinned first, then the always-visible Fusion
 * row (disabled with a setup hint when no pair is configured), then recent
 * (≤5, MRU), then the preset models, then EVERY other available model — the
 * catalogue is never hidden, the preset only controls ordering. Typing filters
 * all rows except the pinned one.
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
 * preset lists. With the effort control focused, Space toggles whether ←/→
 * adjusts the lead's or the sidekick's effort (default: lead).
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
  /** pi's persisted startup model — its row gets a dim `default` tag. */
  defaultModelKey: ModelKey | undefined;
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
  /** alt+enter: persist the highlighted row as the startup default (then apply). */
  onSetDefault?: (result: PickerResult) => void;
  onRenderRequest?: (() => void) | undefined;
  /** Rows visible in the list window. */
  visibleRows?: number | undefined;
}

// ── Rows ───────────────────────────────────────────────────────────────────

type Row = { kind: "fusion" } | { kind: "model"; key: ModelKey };
type FusionFocus = "effort" | "lead" | "sidekick";

const DEFAULT_VISIBLE_ROWS = 10;
/** Minimum width of the name column (the pre-autosize default). */
const NAME_COL_MIN = 24;
const MARKER_COL = 2;
const BAR_SEGMENTS = 5;
/** Visible columns outside the name: pointer + marker prefix (4) + effort block (19). */
const FIXED_COLS = 23;

/**
 * A model needs a provider prefix when its display name alone is ambiguous:
 * it contains a "/" (so it reads like a `provider/id` key), or the same name
 * is offered by more than one provider.
 */
function ambiguousNamesOf(models: readonly PickerModel[]): Set<string> {
  const providersByName = new Map<string, Set<string>>();
  for (const m of models) {
    const set = providersByName.get(m.name) ?? new Set<string>();
    set.add(m.provider);
    providersByName.set(m.name, set);
  }
  const out = new Set<string>();
  for (const [name, set] of providersByName) {
    if (set.size > 1) out.add(name);
  }
  return out;
}

function needsProvider(m: PickerModel, ambiguous: ReadonlySet<string>): boolean {
  return m.name.includes("/") || ambiguous.has(m.name);
}

function labelOf(m: PickerModel, ambiguous: ReadonlySet<string>): string {
  return needsProvider(m, ambiguous) ? `${m.provider} \u00b7 ${m.name}` : m.name;
}

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

function hasPricing(cost: PickerModel["cost"]): cost is NonNullable<PickerModel["cost"]> {
  return cost !== undefined && (cost.input > 0 || cost.cachedInput > 0 || cost.output > 0);
}

function pad(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

export class ModelPicker {
  private readonly theme: PickerTheme;
  private readonly onDone: (result: PickerResult) => void;
  private readonly onSetDefault?: (result: PickerResult) => void;
  private readonly onRenderRequest: (() => void) | undefined;
  private readonly visibleRows: number;
  private readonly modelsByKey: Map<ModelKey, PickerModel>;
  private readonly state: PickerState;
  private readonly priceRange: { min: number; max: number };
  private readonly ambiguousNames: Set<string>;
  /** Name column sized to the widest row label; capped to the available width at render time. */
  private readonly naturalNameCol: number;

  private effort: Record<ModelKey, EffortLevel>;
  /** Fusion-row efforts — deliberately NOT stored in the per-model map. */
  private fusionLeadEffort: EffortLevel;
  private fusionSidekickEffort: EffortLevel;
  private lead: ModelKey | undefined;
  private sidekick: ModelKey | undefined;
  private search = "";
  private selected = 0;
  private focus: FusionFocus = "effort";
  /** Which side ←/→ adjusts on the Fusion row's effort control. */
  private effortTarget: "lead" | "sidekick" = "lead";
  private dropdownIndex = 0;
  private done = false;

  constructor(options: PickerOptions) {
    this.state = options.state;
    this.theme = options.theme;
    this.onDone = options.onDone;
    this.onSetDefault = options.onSetDefault;
    this.onRenderRequest = options.onRenderRequest;
    this.visibleRows = options.visibleRows ?? DEFAULT_VISIBLE_ROWS;
    this.modelsByKey = new Map(options.state.models.map((m) => [m.key, m]));
    this.ambiguousNames = ambiguousNamesOf(options.state.models);
    const widestLabel = options.state.models.reduce(
      (max, m) => Math.max(max, visibleWidth(labelOf(m, this.ambiguousNames))),
      0,
    );
    this.naturalNameCol = Math.max(NAME_COL_MIN, widestLabel + 2);
    const prices = options.state.models.map((m) => (hasPricing(m.cost) ? blendedPrice(m.cost) : undefined)).filter((p): p is number => p !== undefined && p > 0);
    this.priceRange = { min: prices.length > 0 ? Math.min(...prices) : 0, max: prices.length > 0 ? Math.max(...prices) : 0 };
    this.effort = { ...options.state.effort };
    const active = options.state.active;
    // Saved keys can go stale (provider renamed a model, logged out); only
    // accept ones still in the catalogue, else the Fusion row looks ready but
    // cannot be applied.
    const known = (...keys: (ModelKey | undefined)[]): ModelKey | undefined =>
      keys.find((k) => k !== undefined && this.modelsByKey.has(k));
    this.lead = known(
      active?.kind === "fusion" ? active.lead : undefined,
      options.state.fusionDefault.lead,
      ...options.state.fusionLeads,
    );
    this.sidekick = known(
      active?.kind === "fusion" ? active.sidekick : undefined,
      options.state.fusionDefault.sidekick,
      ...options.state.fusionSidekicks,
    );
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
    if (!pinnedFusion) out.push({ kind: "fusion" });

    const ordered: ModelKey[] = [
      ...this.state.recent,
      ...this.state.fusionLeads,
      ...this.state.fusionSidekicks,
    ];
    // The preset IS the list; the rest of the catalogue appears only while
    // searching (or when nothing is curated yet, so Fusion stays usable).
    if (this.search.length > 0 || !this.hasPreset()) ordered.push(...this.state.models.map((m) => m.key));
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

  /** Whether any lead/sidekick is curated (and still in the catalogue). */
  private hasPreset(): boolean {
    return [...this.state.fusionLeads, ...this.state.fusionSidekicks].some((k) => this.modelsByKey.has(k));
  }

  /** Dropdown entries: only the curated list for this side. Typing searches
   *  the whole catalogue (curated matches first, a dim separator, the rest);
   *  an empty list offers the whole catalogue (Fusion works uncurated). */
  private dropdownEntries(): Array<ModelKey | "sep"> {
    const source = this.focus === "lead" ? this.state.fusionLeads : this.state.fusionSidekicks;
    const listed = source.filter((k) => this.modelsByKey.has(k));
    const curated = listed.filter((k) => this.matchesSearch(k));
    if (listed.length > 0 && this.search.length === 0) return curated;
    const rest = this.state.models.map((m) => m.key).filter((k) => !curated.includes(k) && this.matchesSearch(k));
    if (curated.length === 0) return rest;
    if (rest.length === 0) return curated;
    return [...curated, "sep", ...rest];
  }

  private dropdownItems(): ModelKey[] {
    return this.dropdownEntries().filter((e): e is ModelKey => e !== "sep");
  }

  // ── Input ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.done) return;
    const row = this.selectedRow();
    const inDropdown = row?.kind === "fusion" && this.focus !== "effort";

    if (matchesKey(data, Key.escape)) {
      if (inDropdown) {
        this.focus = "effort";
        this.search = "";
        this.changed();
        return;
      }
      this.finish({ type: "cancelled" });
      return;
    }

    const disabledFusion = row?.kind === "fusion" && !this.fusionAvailable();
    if (disabledFusion && !inDropdown) {
      // Incomplete pair: Enter/Tab open the dropdown for the missing half.
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter) || data === "\r") {
        this.openMissing();
        this.changed();
        return;
      }
      if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, "alt+enter")) return;
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
      } else if (matchesKey(data, "alt+enter")) {
        this.applyDropdown(items);
        if (!this.fusionAvailable()) this.openMissing();
        else {
          this.focus = "effort";
          this.setDefault(row);
          this.confirm(row);
          return;
        }
      } else if (matchesKey(data, Key.enter) || data === "\r") {
        this.applyDropdown(items);
        this.search = "";
        if (this.fusionAvailable()) this.focus = "effort";
        else this.openMissing();
      } else if (matchesKey(data, Key.backspace) || data === "\x7f") {
        // Typing in a dropdown searches the whole catalogue.
        this.search = this.search.slice(0, -1);
        this.dropdownIndex = 0;
      } else {
        const ch = printable(data);
        if (ch === undefined || ch === " ") return;
        this.search += ch;
        this.dropdownIndex = 0;
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
        // Space picks which side ←/→ adjusts.
        if (this.focus === "effort") {
          if (this.effortTarget === "lead") this.fusionLeadEffort = stepEffort(this.fusionLeadEffort, delta);
          else this.fusionSidekickEffort = stepEffort(this.fusionSidekickEffort, delta);
        }
      } else if (row?.key !== undefined) {
        this.effort[row.key] = stepEffort(this.effortFor(row.key), delta);
      }
    } else if (matchesKey(data, Key.tab)) {
      // Fusion row: Tab cycles focus (lead → sidekick → effort). Model rows:
      // Tab = activate, same as Enter (hub key contract).
      if (row?.kind === "fusion") this.cycleFocus(matchesKey(data, "shift+tab"));
      else if (!disabledFusion) {
        this.confirm(row);
        return;
      }
    } else if (data === " " || matchesKey(data, Key.space)) {
      // Space = quick action. On a model row it stages the highlighted model
      // as the Fusion lead; on the Fusion row it toggles which side the
      // effort control adjusts (Tab is taken by the lead/sidekick cycle).
      if (row?.kind === "fusion") {
        if (this.focus === "effort" && this.fusionAvailable()) {
          this.effortTarget = this.effortTarget === "lead" ? "sidekick" : "lead";
          this.changed();
        }
        return;
      }
      if (row?.kind === "model" && !disabledFusion) {
        this.lead = row.key;
        this.changed();
        return;
      }
      return;
    } else if (matchesKey(data, "alt+enter")) {
      // Alt+Enter = apply AND keep it as the startup default.
      this.setDefault(row);
      this.confirm(row);
      return;
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

  /** Open the lead (or, if the lead is set, the sidekick) dropdown. */
  private openMissing(): void {
    this.focus = this.lead === undefined ? "effort" : "lead"; // cycleFocus steps one past this
    this.cycleFocus();
  }

  private applyDropdown(items: ModelKey[]): void {
    const pick = items[this.dropdownIndex];
    if (pick === undefined) return;
    if (this.focus === "lead") this.lead = pick;
    else this.sidekick = pick;
  }

  private setDefault(row: Row | undefined): void {
    if (row === undefined || this.onSetDefault === undefined) return;
    const mark = row.kind === "fusion" ? this.lead : row.key;
    if (mark !== undefined) this.state.defaultModelKey = mark;
    this.changed();
    if (row.kind === "fusion") {
      if (this.lead === undefined || this.sidekick === undefined) return;
      this.onSetDefault({
        type: "fusion",
        lead: this.lead,
        sidekick: this.sidekick,
        leadEffort: this.fusionLeadEffort,
        sidekickEffort: this.fusionSidekickEffort,
        effortMap: { ...this.effort },
      });
    } else if (row.key !== undefined) {
      this.onSetDefault({
        type: "single",
        model: row.key,
        effort: this.effortFor(row.key),
        effortMap: { ...this.effort },
      });
    }
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

  private isAmbiguous(model: PickerModel): boolean {
    return needsProvider(model, this.ambiguousNames);
  }

  private renderRow(row: Row, highlighted: boolean, width: number, nameCol: number): string {
    const t = this.theme;
    const pointer = highlighted ? t.fg("accent", "❭") : t.fg("dim", "·");
    const disabledFusion = row.kind === "fusion" && !this.fusionAvailable();
    // The Fusion composite gets the check when it is the active selection —
    // same affordance a single active model gets on its own row.
    const marker =
      row.kind === "fusion"
        ? !disabledFusion && this.state.active?.kind === "fusion"
          ? t.fg("success", "✓")
          : " "
        : this.markerFor(row.key);
    const working = row.kind === "model" && row.key === this.state.currentModelKey;
    const model = row.kind === "model" ? this.modelsByKey.get(row.key) : undefined;
    // Only ambiguous rows (slash-y names, or names shared across providers) pay
    // the width cost of a dim provider prefix. The name is truncated, never the
    // prefix, so `openrouter · …` always survives.
    const providerPrefix = model !== undefined && this.isAmbiguous(model) ? t.fg("dim", `${model.provider} · `) : "";
    const nameBudget = Math.max(1, nameCol - visibleWidth(providerPrefix) - 1);
    const nameRaw = row.kind === "fusion" ? "Fusion" : this.nameOf(row.key, nameBudget);
    const styled =
      row.kind === "fusion"
        ? disabledFusion
          ? highlighted
            ? t.fg("muted", t.bold(nameRaw))
            : t.fg("dim", nameRaw)
          : highlighted
            ? t.fg("accent", t.bold(nameRaw))
            : t.fg("text", nameRaw)
        : working
          ? t.fg("accent", t.bold(nameRaw))
          : highlighted
            ? t.fg("accent", nameRaw)
            : t.fg("text", nameRaw);
    const name = `${providerPrefix}${styled}${row.kind === "model" && row.key === this.state.defaultModelKey ? ` ${t.fg("dim", "default")}` : ""}`;
    const badge = model?.badge;
    const badgeGlyph = badge === undefined ? "" : ` ${t.fg(badge === "new" ? "success" : badge === "promotion" ? "accent" : "warning", "✱")}`;

    const level =
      row.kind === "fusion"
        ? this.effortTarget === "lead"
          ? this.fusionLeadEffort
          : this.fusionSidekickEffort
        : this.effortFor(row.key);
    const arrowsOn = !disabledFusion && highlighted && this.focus === "effort";
    const left = arrowsOn ? t.fg("accent", "←") : " ";
    const right = arrowsOn ? t.fg("accent", "→") : " ";
    const label = disabledFusion
      ? t.fg("dim", effortLabel(level))
      : highlighted
        ? t.fg("accent", effortLabel(level))
        : t.fg("muted", effortLabel(level));

    let line = `${pointer} ${marker} ${pad(`${name}${badgeGlyph}`, nameCol)} ${left} ${this.bar(level, !disabledFusion && highlighted)} ${right} ${pad(label, 8)}`;

    if (row.kind === "fusion") {
      if (!disabledFusion) {
        const leadName = this.nameOf(this.lead, 14);
        const sideName = this.nameOf(this.sidekick, 14);
        const leadFocused = highlighted && this.focus === "lead";
        const sideFocused = highlighted && this.focus === "sidekick";
        // Each side shows its effort; a ▸ marks the side ←/→ adjusts.
        const effortSuffix = (side: "lead" | "sidekick") => {
          const lv = effortLabel(side === "lead" ? this.fusionLeadEffort : this.fusionSidekickEffort);
          return highlighted && this.focus === "effort" && this.effortTarget === side
            ? t.fg("accent", t.bold(` ▸${lv}`))
            : t.fg("dim", ` ${lv}`);
        };
        const leadText = leadFocused
          ? `${t.fg("accent", t.bold("Lead"))} ${t.fg("accent", leadName)} ${t.fg("accent", "▾")}${effortSuffix("lead")}`
          : `${t.fg("dim", "Lead")} ${t.fg("text", leadName)} ${t.fg("dim", "▾")}${effortSuffix("lead")}`;
        const sideText = sideFocused
          ? `${t.fg("accent", t.bold("Sidekick"))} ${t.fg("accent", sideName)} ${t.fg("accent", "▾")}${effortSuffix("sidekick")}`
          : `${t.fg("dim", "Sidekick")} ${t.fg("text", sideName)} ${t.fg("dim", "▾")}${effortSuffix("sidekick")}`;
        line += `   ${leadText}   ${sideText}`;
      }
    }
    return truncateToWidth(line, Math.max(1, width - 1));
  }

  private renderDropdown(width: number, nameCol: number): string[] {
    const t = this.theme;
    const entries = this.dropdownEntries();
    const items = this.dropdownItems();
    const indent = " ".repeat(MARKER_COL + nameCol + 5);
    if (items.length === 0) {
      return [`${indent}${t.fg("warning", "no matching models")}`];
    }
    // Selectable index ↔ entry index mapping (a "sep" row renders but can't be picked).
    const selectableIdx = new Map<ModelKey, number>();
    items.forEach((key, i) => selectableIdx.set(key, i));
    const firstEntryOfSel = items.map((key) => entries.indexOf(key));
    const win = 8;
    const selStart = Math.max(0, Math.min(this.dropdownIndex - Math.floor(win / 2), items.length - win));
    const sliceStart = firstEntryOfSel[selStart] ?? 0;
    const slice = entries.slice(sliceStart, sliceStart + win);
    const above = sliceStart;
    const below = Math.max(0, entries.length - (sliceStart + slice.length));
    const more = (n: number, dir: string) => truncateToWidth(`${indent}${t.fg("dim", `${dir} ${String(n)} more`)}`, Math.max(1, width - 1));
    return [
      ...(above > 0 ? [more(above, "↑")] : []),
      ...slice.map((entry) => {
      if (entry === "sep") return truncateToWidth(`${indent}${t.fg("dim", "── all models ──")}`, Math.max(1, width - 1));
      const selIdx = selectableIdx.get(entry) ?? 0;
      const isCur = selIdx === this.dropdownIndex;
      const isSet = entry === (this.focus === "lead" ? this.lead : this.sidekick);
      const glyph = isCur ? t.fg("accent", "▸") : " ";
      const label = isCur ? t.fg("accent", t.bold(this.nameOf(entry, 28))) : t.fg("text", this.nameOf(entry, 28));
      const star = isSet ? t.fg("dim", " *") : "";
      return truncateToWidth(`${indent}${glyph} ${label}${star}`, Math.max(1, width - 1));
      }),
      ...(below > 0 ? [more(below, "↓")] : []),
    ];
  }

  private renderPricePanel(row: Row | undefined, width: number): string[] {
    const t = this.theme;
    if (row === undefined) return [];
    const disabledFusion = row.kind === "fusion" && !this.fusionAvailable();
    const primaryKey = row.kind === "fusion" ? this.lead : row.key;
    const primary = primaryKey === undefined ? undefined : this.modelsByKey.get(primaryKey);
    const side = row.kind === "fusion" && this.sidekick !== undefined ? this.modelsByKey.get(this.sidekick) : undefined;
    const primaryCost = primary?.cost;
    const sideCost = side?.cost;
    const cols: Array<[string, string]> = [];
    if (hasPricing(primaryCost)) {
      cols.push(["Input", money(primaryCost.input)]);
      cols.push(["Cached input", money(primaryCost.cachedInput)]);
      cols.push(["Output", money(primaryCost.output)]);
    } else {
      cols.push(["Input", "—"], ["Cached input", "—"], ["Output", "—"]);
    }
    if (row.kind === "fusion") {
      if (hasPricing(sideCost)) {
        cols.push(["Sidekick input", money(sideCost.input)]);
        cols.push(["Sidekick cached input", money(sideCost.cachedInput)]);
        cols.push(["Sidekick output", money(sideCost.output)]);
      } else {
        cols.push(["Sidekick input", "—"], ["Sidekick cached input", "—"], ["Sidekick output", "—"]);
      }
    }
    const need = Math.max(...cols.map(([h, v]) => Math.max(visibleWidth(h), visibleWidth(v)))) + 3;
    const colWidth = Math.max(10, Math.min(need, Math.floor((width - 4) / cols.length)));
    const head = cols.map(([h]) => pad(t.fg("dim", h), colWidth)).join("");
    const vals = cols.map(([, v]) => pad(t.fg("text", v), colWidth)).join("");
    const desc =
      disabledFusion
        ? t.fg("warning", "Run /unipi:settings (Fusion) to enable Fusion — a powerful lead model plans and reviews while a cheaper sidekick executes, for frontier performance at lower cost")
        : row.kind === "fusion"
          ? t.fg("dim", "Pairs frontier intelligence with cost-efficient execution")
          : primary?.reasoning
            ? t.fg("dim", "Reasoning model · ←/→ adjusts thinking effort")
            : t.fg("dim", "Non-reasoning model · effort is ignored by the provider");
    const badges = this.state.models.some((m) => m.badge !== undefined)
      ? `${t.fg("success", "✱")} ${t.fg("dim", "New")}  ${t.fg("accent", "✱")} ${t.fg("dim", "Promotion")}  ${t.fg("warning", "✱")} ${t.fg("dim", "Beta")} ${t.fg("dim", "·")}`
      : "";
    const noPricing = row.kind === "fusion"
      ? !hasPricing(primaryCost) || !hasPricing(sideCost)
      : !hasPricing(primaryCost);
    const pricing = !disabledFusion && noPricing ? t.fg("dim", " · no pricing data from provider") : "";
    const description = `${badges}${badges.length > 0 ? " " : ""}${desc}${pricing}`;
    // The row label may be a friendly name; spell out the exact registry key so
    // the highlighted model is unambiguous (`openrouter/deepseek/...`).
    const keys = row.kind === "fusion"
      ? [this.lead, this.sidekick].filter((k): k is ModelKey => k !== undefined)
      : primaryKey === undefined
        ? []
        : [primaryKey];
    const out = [
      truncateToWidth(`  ${head}`, width - 1),
      truncateToWidth(`  ${vals}`, width - 1),
    ];
    if (keys.length > 0) {
      const keyText = keys.map((k) => t.fg("text", k)).join(t.fg("dim", " · "));
      out.push(truncateToWidth(`  ${t.fg("dim", "Model key")}  ${keyText}`, width - 1));
    }
    for (const line of wrapTextWithAnsi(`  ${description}`, Math.max(1, width - 1)).slice(0, 3)) {
      out.push(truncateToWidth(line, width - 1));
    }
    return out;
  }

  private hintLine(row: Row | undefined): string {
    const t = this.theme;
    const parts: string[] = [];
    if (row?.kind === "fusion" && !this.fusionAvailable()) {
      parts.push("↑↓ select", `enter pick ${this.lead === undefined ? "lead" : "sidekick"}`, "esc cancel");
    } else if (row?.kind === "fusion" && this.focus !== "effort") {
      parts.push("↑↓ select", "type to search all models", `tab ${this.focus === "lead" ? "sidekick" : "effort"}`, "enter apply", "alt+enter set default", "esc collapse");
    } else {
      parts.push("↑↓ select");
      if (row?.kind === "fusion") {
        const other = this.effortTarget === "lead" ? "sidekick" : "lead";
        parts.push("tab lead", `←→ ${this.effortTarget} effort`, `space → ${other}`, "enter confirm", "alt+enter set default", "esc cancel");
      } else {
        parts.push("←→ effort", "enter/tab confirm", "alt+enter set default", "space set lead", "esc cancel");
      }
    }
    return t.fg("dim", parts.join(" · "));
  }

  render(width: number): string[] {
    return frameOverlay(this.renderBody(Math.max(4, width - 2)), width, { title: "Model" });
  }

  private renderBody(width: number): string[] {
    const t = this.theme;
    const rows = this.rows();
    // Give the name column every spare column (the effort control stays
    // right-anchored) but never less than the historical 24.
    const maxNameCol = Math.max(NAME_COL_MIN, width - FIXED_COLS - 1);
    const nameCol = Math.min(this.naturalNameCol, maxNameCol);
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
        lines.push(this.renderRow(r, highlighted, width, nameCol));
        if (r.kind === "fusion" && !this.fusionAvailable()) {
          lines.push(truncateToWidth(`   ${t.fg("dim", "pick a lead and sidekick — the catalogue below works too (open /unipi:settings → Fusion → Edit fusion presets… to curate)")}`, Math.max(1, width - 1)));
        }
        if (highlighted && r.kind === "fusion" && this.focus !== "effort") {
          lines.push(...this.renderDropdown(width, nameCol));
        }
      }
      if (end < rows.length) lines.push(t.fg("dim", `  ↓ more below (${String(rows.length - end)})`));
    }

    lines.push("");
    const sliderCells = Math.min(48, Math.max(1, width - 6));
    const sliderKey = row?.kind === "fusion" ? this.lead : row?.key;
    const sliderModel = sliderKey === undefined ? undefined : this.modelsByKey.get(sliderKey);
    const sliderCost = sliderModel?.cost;
    const sliderPrice = hasPricing(sliderCost) ? blendedPrice(sliderCost) : undefined;
    const marker = this.priceRange.max <= 0 || sliderPrice === undefined ? undefined : sliderPosition(sliderPrice, this.priceRange.min, this.priceRange.max, sliderCells);
    lines.push(truncateToWidth(`  ${renderSlider(sliderCells, marker)}`, width - 1));
    lines.push(...this.renderPricePanel(row, width));
    lines.push("");
    lines.push(this.hintLine(row));
    return lines;
  }
}
