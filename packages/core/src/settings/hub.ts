/**
 * The /unipi:settings hub — every registered module's settings in one panel.
 *
 * Interaction spec (user, 2026-09-22; instant-apply, no staged state):
 *   ↑/k ↓/j   move
 *   /         search (esc, or backspace on empty input, exits; esc again
 *             closes)
 *   Enter/Tab ACTIVATE: boolean → toggle · enum → option list (custom… only
 *             when allowCustom) · string/number/secret → inline input ·
 *             model → searchable picker · multiselect → checkbox list ·
 *             order → reorder editor · page → open (sections may be a
 *             getter, resolved live at open) · action → run ·
 *             ▸ Advanced → flip
 *   Space     quick action: boolean → toggle · enum → next option (custom…
 *             skipped; custom values restart at the first option) ·
 *             ▸ Advanced → flip · everything else no-op
 *   Esc       input/picker → cancel · search → exit · list → close panel
 *
 * Model picker: search box + EXACTLY 5 visible rows; typing filters; ↑/↓ walk
 * the full filtered list; Enter picks. Catalog: pi's models.json (catalog.ts).
 *
 * Writes go through the engine (setSettings, one patch per change) — reads at
 * open via getSettings; local values update in place after each write.
 */

import {
  decodeKittyPrintable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { frameOverlay, OverlayTheme } from "../../tui-overlay.js";
import { boxInnerWidth } from "../../tui-width.js";
import { namespaceColor } from "../package-colors.js";
import { loadModelCatalogEntries, type ModelCatalogEntry } from "./catalog.js";
import { loadModelCatalog } from "./catalog.js";
import {
  enumOption,
  formatFieldValue,
  getField,
  parseFieldValue,
  setField,
  type SettingsField,
  type SettingsSection,
} from "./schema.js";
import {
  getSettings,
  getSettingsDefinition,
  listSettingsDefinitions,
  setSettings,
  settingsLayers,
  type SettingsScope,
} from "./engine.js";

export interface SettingsHubDeps {
  /** Where project-scope overrides land (the session cwd). */
  readonly cwd: string;
  /** Re-read hook: modules that cache settings call this after a write. */
  readonly onChanged?: (namespace: string) => void;
  /** Model catalog for model-type pickers (tests inject a fixture). */
  readonly modelCatalog?: () => string[];
  /** Catalog entries with metadata (capability filtering); tests may inject. */
  readonly modelCatalogEntries?: () => ModelCatalogEntry[];
  /** Invoker for `action` rows (utility wires core runCommandByName + ctx). */
  readonly runAction?: (command: string) => void | Promise<void>;
  /** Terminal rows for viewport sizing (tests inject; default stdout.rows). */
  readonly terminalRows?: () => number;
}

type Mode = "list" | "search" | "input" | "model";

interface Row {
  readonly kind: "header" | "field" | "toggle";
  readonly id: string;
  readonly label: string;
  readonly namespace?: string;
  /** Module label + section title — search haystack parts ("Judge", "Long-Horizon"). */
  readonly context?: string;
  readonly field?: SettingsField;
  readonly layerTag?: string;
  /** Set on rows from `advanced: true` sections (namespace they disclose). */
  readonly advancedOf?: string;
}

const PAGE_ROWS = 10;
/** Picked value meaning "open the inline editor with the raw text". */
const CUSTOM_VALUE = Symbol("custom");
const HISTORY_CAP = 50;
const overlayTheme = new OverlayTheme();
const dim = (t: string) => overlayTheme.fg("textMuted", t);
const bold = (t: string) => overlayTheme.bold(t);

/**
 * Quick-cycle an enum to the NEXT LISTED option — `custom…` is never offered;
 * a custom (unlisted) value restarts at the first option.
 */
export function nextEnumValue(field: SettingsField, current: unknown): { value: unknown; label: string } | null {
  if (field.type !== "enum" || field.options.length === 0) return null;
  const opts = field.options.map(enumOption);
  const cur = String(current ?? "");
  const idx = opts.findIndex((o) => o.value === cur);
  const next = idx === -1 ? opts[0]! : opts[(idx + 1) % opts.length]!;
  return { value: next.value, label: next.label };
}

export class SettingsHub {
  onClose: () => void = () => {};
  private readonly cwd: string;
  private readonly onChanged?: (namespace: string) => void;
  private readonly catalog: () => string[];
  private readonly entries: () => ModelCatalogEntry[];
  private rows: Row[] = [];
  private cursor = 0;
  private mode: Mode = "list";
  private scope: SettingsScope = "global";
  private readonly values = new Map<string, Record<string, unknown>>();
  private searchInput: Input | null = null;
  private filter = "";
  /** Inline editor state (input mode). */
  private edit: { row: Row; input: Input; error: string | null } | null = null;
  /** Model picker state. */
  private picker: {
    row: Row;
    input: Input;
    /** Display strings (catalog ids, preset ids, enum labels + "custom…"). */
    options: string[];
    /** Parallel picked values; CUSTOM sentinel opens the inline editor. */
    values: unknown[];
    selected: number;
    /** Enum lists ≤8 options show NO search box (typing does nothing). */
    searchable: boolean;
    /** Context line above the list (e.g. "image-input models · 556"). */
    header: string;
    /** multiselect list: Enter/Tab/Space toggle + write, list stays open. */
    multi?: boolean;
    /** order editor: ↑↓ walk, Shift+J/K (alt+↑/↓) shift items, Esc done. */
    order?: boolean;
  } | null = null;
  private renderWidth = 80;
  /** Viewport: index of the first visible row. */
  private scroll = 0;
  /** Values as of panel-open — `R` reverts the cursor's field to these. */
  private readonly baseline = new Map<string, Record<string, unknown>>();
  /** Instant-apply undo stack (LIFO), capped. */
  private history: Array<{ namespace: string; key: string; prev: unknown; scope: SettingsScope; label: string }> = [];
  /** One-render confirmation line (e.g. "undo: Judge enabled"). */
  private toast: string | null = null;
  /** Namespaces whose `advanced` sections are expanded. */
  private readonly expandedAdvanced = new Set<string>();
  /** Nested page stack (push on `page` rows; Esc pops). */
  private readonly pageStack: Array<{
    label: string;
    namespace: string;
    rows: Row[];
    cursor: number;
    scroll: number;
  }> = [];
  private readonly runActionFn?: (command: string) => void | Promise<void>;
  private readonly terminalRowsFn: () => number;

  constructor(deps: SettingsHubDeps) {
    this.cwd = deps.cwd;
    this.onChanged = deps.onChanged;
    this.catalog = deps.modelCatalog ?? loadModelCatalog;
    // Entries power capability/preset pickers; an ids-only fixture still works
    // (its models are treated as text-only).
    this.entries = deps.modelCatalogEntries
      ?? (deps.modelCatalog
        ? () => deps.modelCatalog!().map((id) => ({ id, input: ["text"] as string[] }))
        : loadModelCatalogEntries);
    this.runActionFn = deps.runAction;
    this.terminalRowsFn = deps.terminalRows ?? (() => process.stdout.rows ?? 40);
    this.buildRows();
  }

  private valueOf(namespace: string): Record<string, unknown> {
    let v = this.values.get(namespace);
    if (!v) {
      v = getSettings(namespace, this.cwd);
      this.values.set(namespace, v);
      // First load ≈ panel open: snapshot the baseline for `R` revert.
      if (!this.baseline.has(namespace)) this.baseline.set(namespace, structuredClone(v));
    }
    return v;
  }

  private buildRows(): void {
    const defs = listSettingsDefinitions().filter((d) => d.schema && d.schema.length > 0);
    const rows: Row[] = [];
    for (const def of defs) {
      const layers = settingsLayers(def.namespace, this.cwd);
      const tag = `${layers.global ? "G" : "-"}${layers.project ? "P" : "-"}`;
      const sections = def.schema!;
      const advanced = sections.filter((sec) => sec.advanced === true);
      const plain = sections.filter((sec) => sec.advanced !== true);
      for (const section of plain) {
        rows.push({
          kind: "header", id: `${def.namespace}::${section.title}`,
          label: `${def.label} — ${section.title}`, layerTag: tag,
          namespace: def.namespace,
        });
        for (const field of section.fields) {
          rows.push({
            kind: "field", id: `${def.namespace}::${field.key}`,
            label: field.label, namespace: def.namespace, field,
            context: `${def.label} ${section.title}`,
          });
        }
      }
      if (advanced.length > 0) {
        // One disclosure toggle at the group end reveals all advanced sections.
        rows.push({
          kind: "toggle", id: `${def.namespace}::advanced`,
          label: "▸ Advanced", namespace: def.namespace,
        });
        for (const section of advanced) {
          rows.push({
            kind: "header", id: `${def.namespace}::${section.title}`,
            label: `${def.label} — ${section.title}`, layerTag: tag,
            namespace: def.namespace,
            advancedOf: def.namespace,
          });
          for (const field of section.fields) {
            rows.push({
              kind: "field", id: `${def.namespace}::${field.key}`,
              label: field.label, namespace: def.namespace, field,
              context: `${def.label} ${section.title}`,
              advancedOf: def.namespace,
            });
          }
        }
      }
    }
    this.rows = rows;
    // First row is a header band — start the cursor on a selectable row.
    this.cursor = Math.max(0, this.nextSelectable(rows, 0));
  }

  // ── filtering ───────────────────────────────────────────────────────────
  /** Current page's rows (root rows at stack bottom). */
  private rowsOf(): Row[] {
    return this.pageStack.length > 0 ? this.pageStack[this.pageStack.length - 1]!.rows : this.rows;
  }

  private visibleRows(): Row[] {
    const pageRows = this.rowsOf();
    if (!this.filter) {
      // Progressive disclosure: advanced rows show only when expanded.
      return pageRows.filter((r) => r.kind !== "toggle"
        ? !r.advancedOf || this.expandedAdvanced.has(r.advancedOf)
        : true);
    }
    // Word-wise AND: every word must appear somewhere in the row's haystack
    // (field label, module label, section title, namespace, description) —
    // so "judge model" matches Long-Horizon's Judge section's Model field.
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.rows;
    // Group headers PERSIST under filtering so matching fields keep their
    // context ("Long-Horizon — Judge" above its Model row).
    const out: Row[] = [];
    let currentHeader: Row | undefined;
    for (const r of pageRows) {
      if (r.kind === "toggle") continue; // no toggle rows while searching
      if (r.kind === "header") {
        currentHeader = r;
        continue;
      }
      const haystack = [
        r.label,
        r.context ?? "",
        r.namespace ?? "",
        r.field?.description ?? "",
      ].join(" ").toLowerCase();
      if (words.every((w) => haystack.includes(w))) {
        if (currentHeader && out[out.length - 1] !== currentHeader) out.push(currentHeader);
        out.push(r);
      }
    }
    return out;
  }

  /** First selectable (non-header) row index at or after `from` (or -1). */
  private nextSelectable(visible: Row[], from: number): number {
    for (let i = from; i < visible.length; i++) if (visible[i]!.kind !== "header") return i;
    return -1;
  }

  /** Previous selectable row index at or before `from` (or -1). */
  private prevSelectable(visible: Row[], from: number): number {
    for (let i = from; i >= 0; i--) if (visible[i]!.kind !== "header") return i;
    return -1;
  }

  /** Normalize cursor onto a selectable row (headers never hold the cursor). */
  private normalizeCursor(): void {
    const visible = this.visibleRows();
    if (visible[this.cursor]?.kind === "header" || this.cursor >= visible.length) {
      const i = this.nextSelectable(visible, this.cursor);
      this.cursor = i >= 0 ? i : Math.max(0, this.prevSelectable(visible, this.cursor - 1));
    }
  }

  private currentRow(): Row | undefined {
    return this.visibleRows()[this.cursor];
  }

  // ── writes ──────────────────────────────────────────────────────────────
  private applyChange(row: Row, value: unknown): void {
    if (!row.namespace || !row.field) return;
    const current = this.valueOf(row.namespace);
    const prev = getField(current, row.field.key);
    const next = setField(current, row.field.key, value);
    this.values.set(row.namespace, next);
    setSettings(row.namespace, setField({}, row.field.key, value), this.scope, this.cwd);
    this.history.push({ namespace: row.namespace, key: row.field.key, prev, scope: this.scope, label: row.label });
    if (this.history.length > HISTORY_CAP) this.history.shift();
    this.onChanged?.(row.namespace);
  }

  // ── recovery: undo / reset-to-default / revert-to-baseline ───────────────

  private undoLast(): void {
    const entry = this.history.pop();
    if (!entry) return;
    const next = setField(this.valueOf(entry.namespace), entry.key, entry.prev);
    this.values.set(entry.namespace, next);
    setSettings(entry.namespace, setField({}, entry.key, entry.prev), entry.scope, this.cwd);
    this.toast = `undo: ${entry.label}`;
    this.onChanged?.(entry.namespace);
  }

  private resetToDefault(row: Row): void {
    if (row.kind !== "field" || !row.namespace || !row.field) return;
    const definition = getSettingsDefinition(row.namespace);
    const fallback = definition ? getField(definition.defaults, row.field.key) : undefined;
    this.applyChange(row, fallback);
    this.toast = `default: ${row.label}`;
  }

  private revertToBaseline(row: Row): void {
    if (row.kind !== "field" || !row.namespace || !row.field) return;
    const snapshot = this.baseline.get(row.namespace);
    const base = snapshot ? getField(snapshot, row.field.key) : undefined;
    this.applyChange(row, base);
    this.toast = `reverted: ${row.label}`;
  }

  /** Build a page's rows from its sections (full keys; namespace from owner). */
  private pageRows(namespace: string, sections: readonly SettingsSection[]): Row[] {
    const rows: Row[] = [];
    for (const section of sections) {
      rows.push({
        kind: "header", id: `${namespace}::page::${section.title}`,
        label: section.title, namespace,
      });
      for (const field of section.fields) {
        rows.push({
          kind: "field", id: `${namespace}::${field.key}`,
          label: field.label, namespace, field,
          context: section.title,
        });
      }
    }
    return rows;
  }

  private openPage(row: Row): void {
    if (row.kind !== "field" || !row.namespace || row.field?.type !== "page") return;
    // Dynamic pages resolve their sections at open time (live registries).
    const sections = typeof row.field.sections === "function" ? row.field.sections() : row.field.sections;
    // A page is a fresh context — a root-level filter must not bleed into it.
    this.filter = "";
    this.searchInput = null;
    this.pageStack.push({
      label: row.field.label,
      namespace: row.namespace,
      rows: this.pageRows(row.namespace, sections),
      cursor: this.cursor, // parent's return position
      scroll: this.scroll,
    });
    this.cursor = 0;
    this.scroll = 0;
    this.normalizeCursor();
  }

  private popPage(): void {
    const top = this.pageStack.pop();
    if (!top) return;
    this.cursor = top.cursor;
    this.scroll = top.scroll;
    this.toast = `back: ${top.label}`;
  }

  private runActionRow(row: Row): void {
    if (row.kind !== "field" || row.field?.type !== "action") return;
    void Promise.resolve(this.runActionFn?.(row.field.command)).catch(() => {
      // Action failures never block the panel.
    });
    this.toast = `run: ${row.field.label}`;
  }

  private toggleScope(): void {
    const defs = listSettingsDefinitions();
    const projectAllowed = defs.some((d) => d.projectOverrides !== false);
    if (!projectAllowed && this.scope === "global") return;
    this.scope = this.scope === "global" ? "project" : "global";
  }

  // ── key handling ────────────────────────────────────────────────────────
  handleInput(data: string): void {
    if (this.mode === "input") return this.handleInputEdit(data);
    if (this.mode === "model") return this.handleInputPicker(data);
    if (this.mode === "search") return this.handleInputSearch(data);
    return this.handleInputList(data);
  }

  /**
   * Key router — pi-tui's matchesKey/decodePrintableKey normalize every
   * terminal encoding (CSI arrows, SS3 arrows, kitty CSI-u chars/keys), so
   * j/k work in herdr/kitty as well as plain xterm. A keypress writes its
   * full escape sequence in one read, so a lone \x1b really is Esc.
   */
  private handleInputList(data: string): void {
    const visible = this.visibleRows();
    // Printable char through any encoding: plain byte or kitty CSI-u.
    const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
    const move = (delta: number): void => {
      // Headers are non-selectable bands — jump straight past them.
      const target = delta > 0
        ? this.nextSelectable(visible, this.cursor + delta)
        : this.prevSelectable(visible, this.cursor + delta);
      if (target >= 0) {
        this.cursor = target;
        return;
      }
      // At an edge: clamp to the extreme selectable row.
      this.cursor = Math.max(0, delta > 0
        ? this.prevSelectable(visible, visible.length - 1)
        : this.nextSelectable(visible, 0));
    };
    if (matchesKey(data, Key.up) || ch === "k") return move(-1);
    if (matchesKey(data, Key.down) || ch === "j") return move(1);
    if (matchesKey(data, Key.pageUp)) return move(-PAGE_ROWS);
    if (matchesKey(data, Key.pageDown)) return move(PAGE_ROWS);
    if (matchesKey(data, Key.home)) {
      this.cursor = Math.max(0, this.nextSelectable(visible, 0));
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.cursor = Math.max(0, this.prevSelectable(visible, visible.length - 1));
      return;
    }
    if (matchesKey(data, Key.slash) || ch === "/") {
      this.mode = "search";
      this.searchInput = new Input({ prompt: "/" });
      return;
    }
    // Recovery keys (omp principle: defaults are always one key away).
    if (ch === "u") return this.undoLast();
    if (ch === "d") {
      const row = this.currentRow();
      if (row && row.field?.type !== "page" && row.field?.type !== "action") this.resetToDefault(row);
      return;
    }
    if (ch === "R") {
      const row = this.currentRow();
      if (row && row.field?.type !== "page" && row.field?.type !== "action") this.revertToBaseline(row);
      return;
    }
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      if (this.pageStack.length > 0) this.popPage();
      else this.onClose();
      return;
    }
    if (ch === "g") return this.toggleScope();
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
      const row = this.currentRow();
      if (!row) return;
      // Unified keys (user-approved): Enter/Tab = ACTIVATE, Space = quick action.
      const quick = matchesKey(data, Key.space);
      if (row.kind === "toggle") {
        if (row.namespace && this.expandedAdvanced.has(row.namespace)) this.expandedAdvanced.delete(row.namespace);
        else if (row.namespace) this.expandedAdvanced.add(row.namespace);
        return;
      }
      if (row.kind !== "field" || !row.field || !row.namespace) return;
      const field = row.field;
      const value = getField(this.valueOf(row.namespace), field.key);
      if (quick) {
        // Quick action: boolean toggle + enum cycle only; everything else no-op.
        if (field.type === "boolean") this.applyChange(row, value !== true);
        else if (field.type === "enum") {
          const next = nextEnumValue(field, value);
          if (next) this.applyChange(row, next.value);
        }
        return;
      }
      switch (field.type) {
        case "boolean":
          this.applyChange(row, value !== true);
          return;
        case "enum":
          this.openEnumList(row);
          return;
        case "string":
        case "number":
        case "secret":
          this.openEdit(row);
          return;
        case "model":
          this.openPicker(row);
          return;
        case "multiselect":
          this.openMultiList(row);
          return;
        case "order":
          this.openOrderList(row);
          return;
        case "page":
          this.openPage(row);
          return;
        case "action":
          this.runActionRow(row);
          return;
      }
    }
  }

  private openEdit(row: Row): void {
    const field = row.field!;
    const value = getField(this.valueOf(row.namespace!), field.key);
    const input = new Input({ prompt: `${field.label}: ` });
    const raw =
      field.type === "secret" && typeof value === "string" ? value :
      value === undefined || value === null ? "" : String(value);
    input.setValue(raw);
    input.handleInput("\x1b[F"); // cursor to end — typing extends the prefilled value
    input.onSubmit = (text) => {
      // Optional field validator gates the raw text before anything applies.
      const validate = "validate" in field ? field.validate : undefined;
      const validationError = validate?.(text.trim()) ?? null;
      if (validationError) {
        this.edit = { row, input, error: validationError };
        return;
      }
      // Enum-custom: the raw text IS the value. Others go through validation.
      const parsed = field.type === "enum" ? text.trim() : parseFieldValue(field, text);
      if (parsed === undefined || parsed === "") {
        this.edit = { row, input, error: field.type === "number" ? "invalid number" : "invalid value" };
        return;
      }
      this.applyChange(row, parsed);
      this.edit = null;
      this.mode = "list";
    };
    input.onEscape = () => {
      this.edit = null;
      this.mode = "list";
    };
    this.edit = { row, input, error: null };
    this.mode = "input";
  }

  private openPicker(row: Row): void {
    const field = row.field!;
    let options = this.catalog();
    let header = `model catalog · ${options.length}`;
    if (field.type === "model") {
      // Source list: sibling-selected presets > static presets > filtered catalog.
      const sibling = field.providerKey
        ? String(getField(this.valueOf(row.namespace!), field.providerKey) ?? "")
        : "";
      const fromSibling = field.providerKey && sibling &&
        field.presetsByProvider && sibling in field.presetsByProvider
        ? [...field.presetsByProvider[sibling]!]
        : null;
      if (fromSibling) {
        options = fromSibling;
        header = `presets (${sibling}) · custom… for any id`;
      } else if (field.presets) {
        options = [...field.presets];
        header = "presets · custom… for any id";
      } else {
        const entries = this.entries();
        if (field.capability) {
          const want = field.capability === "image-input" ? "image" : field.capability;
          options = entries.filter((e) => e.input.includes(want)).map((e) => e.id);
          header = `${field.capability} models · ${options.length}`;
        } else if (field.filter) {
          const matches = field.filter;
          options = entries.filter((e) => matches(e)).map((e) => e.id);
          header = `filtered models · ${options.length}`;
        }
        if (field.provider) options = options.filter((id) => id.startsWith(`${field.provider}/`));
      }
    }
    const input = new Input({ prompt: "search: " });
    const start = getField(this.valueOf(row.namespace!), field.key);
    // Prefill only when the value is IN the list — otherwise the search would
    // filter the list to nothing (custom values aren't listed ids).
    if (typeof start === "string" && start && options.includes(start)) {
      input.setValue(start);
      input.handleInput("\x1b[F");
    }
    // Trailing custom… lets values outside the list in through the editor.
    const allOptions = [...options, "custom…"];
    const allValues: unknown[] = [...options, CUSTOM_VALUE];
    // Optional first entry that picks "" (e.g. back to "inherit (session model)").
    if (field.type === "model" && field.emptyOption) {
      allOptions.unshift(field.emptyOption);
      allValues.unshift("");
    }
    this.picker = {
      row,
      input,
      options: allOptions,
      values: allValues,
      selected: 0,
      searchable: true,
      header,
    };
    this.mode = "model";
  }

  /**
   * Enum option list (Enter/Tab on an enum row). `custom…` appears only for
   * allowCustom fields; ≤8 options show NO search box.
   */
  private openEnumList(row: Row): void {
    const field = row.field!;
    if (field.type !== "enum") return;
    const opts = field.options.map(enumOption);
    const custom = field.allowCustom === true;
    const options = custom ? [...opts.map((o) => o.label), "custom…"] : opts.map((o) => o.label);
    const values: unknown[] = custom ? [...opts.map((o) => o.value), CUSTOM_VALUE] : opts.map((o) => o.value);
    const start = getField(this.valueOf(row.namespace!), field.key);
    const idx = opts.findIndex((o) => o.value === String(start));
    const input = new Input({ prompt: "search: " });
    this.picker = {
      row,
      input,
      options,
      values,
      selected: idx >= 0 ? idx : 0,
      searchable: options.length > 8,
      header: "",
    };
    this.mode = "model";
  }

  /**
   * multiselect editor: one row per option with an [x]/[ ] checkbox. Enter,
   * Tab and Space toggle the highlighted option and write instantly; the
   * list stays open until Esc.
   */
  private openMultiList(row: Row): void {
    const field = row.field!;
    if (field.type !== "multiselect") return;
    const opts = field.options.map(enumOption);
    const selectedValue = new Set(Array.isArray(getField(this.valueOf(row.namespace!), field.key))
      ? (getField(this.valueOf(row.namespace!), field.key) as unknown[]).map(String)
      : []);
    const input = new Input({ prompt: "search: " });
    this.picker = {
      row,
      input,
      options: opts.map((o) => o.label),
      values: opts.map((o) => o.value),
      selected: 0,
      searchable: opts.length > 8,
      header: `${opts.filter((o) => selectedValue.has(o.value)).length}/${opts.length} selected · space/enter toggle · esc done`,
      multi: true,
    };
    this.mode = "model";
  }

  /** order editor: the current value order; Shift+J/K (alt+↑/↓) shift items. */
  private openOrderList(row: Row): void {
    const field = row.field!;
    if (field.type !== "order") return;
    const universe = field.items();
    const stored = getField(this.valueOf(row.namespace!), field.key);
    const known = new Set(universe.map((i) => i.value));
    // Current order first (unknown ids dropped), then any never-ordered items.
    const ids = (Array.isArray(stored) ? stored.map(String) : []).filter((id) => known.has(id));
    for (const item of universe) if (!ids.includes(item.value)) ids.push(item.value);
    this.picker = {
      row,
      input: new Input({ prompt: "" }),
      options: ids.map((id) => universe.find((i) => i.value === id)?.label ?? id),
      values: [...ids],
      selected: 0,
      searchable: false,
      header: `↑↓/jk move · J/K or alt+↑↓ shift · esc done`,
      order: true,
    };
    this.mode = "model";
  }

  private pickerFiltered(): number[] {
    const p = this.picker;
    if (!p) return [];
    if (!p.searchable) return p.options.map((_, i) => i);
    const q = p.input.getValue().trim().toLowerCase();
    return p.options
      .map((label, i) => (label.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i >= 0);
  }

  private handleInputPicker(data: string): void {
    const p = this.picker;
    if (!p) { this.mode = "list"; return; }
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.picker = null;
      this.mode = "list";
      return;
    }
    if (p.order) return this.handleOrderPicker(data, p);
    if (p.multi) return this.handleMultiPicker(data, p);
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || data === "\r" || data === "\n") {
      const filtered = this.pickerFiltered();
      const idx = filtered[p.selected];
      const value = idx === undefined ? undefined : p.values[idx];
      this.picker = null;
      this.mode = "list";
      if (value === CUSTOM_VALUE) {
        this.openEdit(p.row); // enum custom → inline editor (prefilled raw)
        return;
      }
      if (value !== undefined) this.applyChange(p.row, value);
      return;
    }
    const ch2 = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
    const up = matchesKey(data, Key.up) || (!p.searchable && ch2 === "k");
    const down = matchesKey(data, Key.down) || (!p.searchable && ch2 === "j");
    if (up || down) {
      const n = this.pickerFiltered().length;
      if (n > 0) p.selected = (p.selected + (down ? 1 : -1) + n) % n;
      return;
    }
    if (!p.searchable) return; // small option lists ignore typing
    // k/j are TEXT here (model ids contain them) — arrows walk the list.
    p.input.handleInput(data);
    p.selected = 0; // any text change resets selection
  }

  /** Toggle-and-stay-open multiselect list: enter/tab/space toggle + write. */
  private handleMultiPicker(data: string, p: NonNullable<SettingsHub["picker"]>): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || matchesKey(data, Key.space)
      || data === "\r" || data === "\n" || data === " ") {
      const filtered = this.pickerFiltered();
      const idx = filtered[p.selected];
      if (idx === undefined) return;
      const field = p.row.field!;
      if (field.type !== "multiselect") return;
      const optionValue = String(p.values[idx]);
      const current = new Set(Array.isArray(getField(this.valueOf(p.row.namespace!), field.key))
        ? (getField(this.valueOf(p.row.namespace!), field.key) as unknown[]).map(String)
        : []);
      // Canonical option order keeps the stored array stable across toggles.
      current.has(optionValue) ? current.delete(optionValue) : current.add(optionValue);
      const next = field.options.map(enumOption).filter((o) => current.has(o.value)).map((o) => o.value);
      this.applyChange(p.row, next);
      return; // list stays open
    }
    const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
    const up = matchesKey(data, Key.up) || (!p.searchable && ch === "k");
    const down = matchesKey(data, Key.down) || (!p.searchable && ch === "j");
    if (up || down) {
      const n = this.pickerFiltered().length;
      if (n > 0) p.selected = (p.selected + (down ? 1 : -1) + n) % n;
      return;
    }
    if (!p.searchable) return;
    p.input.handleInput(data);
    p.selected = 0;
  }

  /** order editor: ↑↓/jk walk; Shift+J/K (alt+↑/↓) shift items and write. */
  private handleOrderPicker(data: string, p: NonNullable<SettingsHub["picker"]>): void {
    const field = p.row.field!;
    if (field.type !== "order") return;
    const move = (delta: -1 | 1): void => {
      const ids = p.values.map(String);
      const at = p.selected;
      const to = at + delta;
      if (to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to]!, ids[at]!];
      p.values = ids;
      p.options = ids.map((id) => field.items().find((i) => i.value === id)?.label ?? id);
      p.selected = to; // follow the moved item
      this.applyChange(p.row, ids);
    };
    const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
    // Shift+J/K arrive as the uppercase letters in legacy mode; alt+↑/↓ via CSI.
    if (matchesKey(data, "shift+j") || matchesKey(data, "alt+down")) return move(1);
    if (matchesKey(data, "shift+k") || matchesKey(data, "alt+up")) return move(-1);
    if (matchesKey(data, Key.up) || ch === "k") {
      const n = p.values.length;
      if (n > 0) p.selected = (p.selected - 1 + n) % n;
      return;
    }
    if (matchesKey(data, Key.down) || ch === "j") {
      const n = p.values.length;
      if (n > 0) p.selected = (p.selected + 1) % n;
      return;
    }
    // Enter/tab/space are inert here — Esc is the only exit.
  }

  private handleInputSearch(data: string): void {
    const input = this.searchInput;
    if (!input) { this.mode = "list"; return; }
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.exitSearch();
      return;
    }
    // Backspace on an EMPTY search input exits search exactly like Esc.
    if ((matchesKey(data, Key.backspace) || data === "\x7f" || data === "\b") && input.getValue() === "") {
      this.exitSearch();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      this.filter = input.getValue();
      this.mode = "list";
      this.cursor = 0;
      this.normalizeCursor();
      return;
    }
    input.handleInput(data);
    this.filter = input.getValue(); // live filtering
    this.cursor = 0;
    this.normalizeCursor();
  }

  /** Leave search: clear the filter, return to list navigation, normalize cursor. */
  private exitSearch(): void {
    this.searchInput = null;
    this.filter = "";
    this.mode = "list";
    this.cursor = 0;
    this.normalizeCursor();
  }

  private handleInputEdit(data: string): void {
    // Tab submits like Enter — intercepted before Input (which ignores it).
    if (matchesKey(data, Key.tab)) {
      const edit = this.edit;
      if (edit) edit.input.onSubmit?.(edit.input.getValue());
      return;
    }
    // pi-tui's Input handles editing + calls onSubmit/onEscape itself.
    this.edit?.input.handleInput(data);
  }

  // ── rendering ───────────────────────────────────────────────────────────
  invalidate(): void {}

  // ── rendering ───────────────────────────────────────────────────────────
  //
  // Every emitted line is measured in PLAIN text at exactly `inner` visible
  // cells; styling wraps whole spans afterwards (ANSI never changes visible
  // width). This is what keeps the background paint uniform — the old mixed
  // styled-then-measured rows miscounted and bled paint past the frame.

  private terminalRows(): number {
    try {
      return this.terminalRowsFn() || 40;
    } catch {
      return 40;
    }
  }

  /** Truncate/pad styled or plain content to exactly `inner` visible cells. */
  private exactRow(content: string, inner: number): string {
    const w = visibleWidth(content);
    if (w === inner) return content;
    if (w > inner) return truncateToWidth(content, Math.max(0, inner), "");
    return content + " ".repeat(inner - w);
  }

  /**
   * Two-column row (label left, value right) measured in plain text first,
   * then styled per span. `markNamespace` swaps the first indent cell for a
   * colored `▌` group mark. Always exactly `inner` cells.
   */
  private rowColumns(
    cursor: string,
    label: string,
    value: string,
    inner: number,
    selected: boolean,
    markNamespace?: string,
  ): string {
    const valW = visibleWidth(value);
    // Cursor + group mark eat 4 cells before the label.
    const room = Math.max(0, inner - 4 - valW - 2);
    const labelT = truncateToWidth(label, room, "…");
    // One trailing cell of air before the frame border.
    const gap = Math.max(1, inner - 4 - visibleWidth(labelT) - valW - 1);
    const mark = markNamespace ? `${this.markSpan(markNamespace)} ` : "  ";
    const labelStyled = selected ? bold(labelT) : labelT;
    const valueStyled = selected ? bold(value) : dim(value);
    return `${cursor}${mark}${labelStyled}${" ".repeat(gap)}${valueStyled}`;
  }

  /** Plain-text group-mark cell: `▌` for colored namespaces, else a space. */
  private markChar(namespace: string | undefined): string {
    return namespaceColor(namespace ?? "") ? "▌" : " ";
  }

  /**
   * Styled `▌` group mark — bold + the namespace's ANSI color. Closes with
   * targeted-off codes ([22m[39m), never [0m: a full reset mid-line would kill
   * the header band's background paint.
   */
  private markSpan(namespace: string | undefined): string {
    const color = namespaceColor(namespace ?? "");
    return color ? `${color}${bold("▌")}\x1b[39m` : " ";
  }

  private renderRow(row: Row, selected: boolean, inner: number): string {
    const cursor = selected ? "› " : "  ";
    if (row.kind === "toggle") {
      const open = row.namespace ? this.expandedAdvanced.has(row.namespace) : false;
      const label = open ? "▾ Advanced" : "▸ Advanced";
      return this.exactRow(this.rowColumns(cursor, label, "enter/tab/space", inner, selected, row.namespace), inner);
    }
    if (row.kind === "header") {
      const tag = row.layerTag ? ` [${row.layerTag}]` : "";
      const plain = this.exactRow(`${this.markChar(row.namespace)} ${row.label}${tag}`, inner);
      const color = namespaceColor(row.namespace ?? "");
      // Distinct full-width band (bg wrap is width-safe — measures on plain);
      // the ▌ sits at column 0 INSIDE the band, in the namespace color.
      const painted = color
        ? this.markSpan(row.namespace) + dim(bold(plain.slice(1)))
        : dim(bold(plain));
      return overlayTheme.bg("customMessageBg", painted);
    }
    const field = row.field!;
    if (field.type === "page") {
      return this.exactRow(this.rowColumns(cursor, row.label, "› open", inner, selected, row.namespace), inner);
    }
    if (field.type === "action") {
      return this.exactRow(this.rowColumns(cursor, row.label, "⏎ run", inner, selected, row.namespace), inner);
    }
    const value = getField(this.valueOf(row.namespace!), field.key);
    // Value only — no per-row key hints (they read inconsistently); the
    // bottom hint line names the keys that work on the cursor's row.
    return this.exactRow(
      this.rowColumns(cursor, row.label, formatFieldValue(field, value), inner, selected, row.namespace),
      inner,
    );
  }

  private renderEdit(inner: number): string[] {
    if (!this.edit) return [];
    const width = Math.max(8, inner - 4);
    const out = this.edit.input.render(width).map((l) => this.exactRow(`  ${l}`, inner));
    const field = this.edit.row.field;
    const hint = field && "hint" in field ? field.hint : undefined;
    if (hint) out.push(this.exactRow(dim(`  ⓘ ${hint}`), inner));
    if (this.edit.error) out.push(this.exactRow(dim(`  ⚠ ${this.edit.error}`), inner));
    return out;
  }

  private renderPicker(inner: number): string[] {
    const p = this.picker;
    if (!p) return [];
    const width = Math.max(8, inner - 4);
    const out: string[] = [];
    // Context line (source + count) when the picker declares one.
    if (p.header) out.push(this.exactRow(dim(`  ${p.header}`), inner));
    // Small option lists (enums ≤8) show NO search box.
    if (p.searchable) out.push(this.exactRow(`  ${p.input.render(width).join("")}`, inner));
    const filtered = this.pickerFiltered();
    const checked = p.multi ? this.checkedSet(p.row) : null;
    const start = Math.min(p.selected, Math.max(0, filtered.length - 5));
    for (let i = start; i < Math.min(start + 5, filtered.length); i++) {
      const sel = i === p.selected;
      const raw = checked
        ? `[${checked.has(String(p.values[filtered[i]!])) ? "x" : " "}] ${p.options[filtered[i]!]}`
        : p.options[filtered[i]!];
      const label = truncateToWidth(`  ${raw}`, width, "…");
      out.push(this.exactRow(sel ? `  ${bold(label)}` : `  ${dim(label)}`, inner));
    }
    // Pad to exactly 5 rows so the panel never jumps.
    for (let i = filtered.length - start; i < 5; i++) out.push(this.exactRow(`  ${dim("  ·")}`, inner));
    out.push(this.exactRow(dim("  enter/tab pick · esc cancel"), inner));
    return out;
  }

  /** Currently selected values of a multiselect row (for the [x] checkboxes). */
  private checkedSet(row: Row): Set<string> {
    const field = row.field;
    const value = field ? getField(this.valueOf(row.namespace!), field.key) : undefined;
    return new Set(Array.isArray(value) ? value.map(String) : []);
  }

  private clampScroll(len: number, maxRows: number): void {
    if (this.cursor < this.scroll) {
      // Scrolled up: keep the header run DIRECTLY above the cursor visible —
      // scroll to its first header (0 when no selectable row precedes), so
      // arriving at a group's first field shows the group band too.
      let start = this.cursor;
      const visible = this.visibleRows();
      while (start > 0 && visible[start - 1]?.kind === "header") start--;
      this.scroll = start;
    }
    if (this.cursor > this.scroll + maxRows - 1) this.scroll = this.cursor - maxRows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, len - maxRows)));
  }

  private hintLine(): string {
    if (this.mode === "search") return "type to filter · enter apply · esc/bksp exit";
    if (this.mode === "input") return "enter/tab save · esc cancel";
    if (this.mode === "model" && this.picker?.multi) return "↑↓ move · space/enter toggle · esc done";
    if (this.mode === "model" && this.picker?.order) return "↑↓/jk move · J/K or alt+↑↓ shift · esc done";
    if (this.mode === "model") return "↑↓ move · enter/tab pick · esc cancel";
    const recover = `${this.history.length > 0 ? "u undo · " : ""}d default · R revert`;
    const row = this.currentRow();
    const f = row?.field;
    if (!f) return `↑↓/kj · / search · g scope · ${recover}`;
    if (f.type === "page") return `enter/tab open · esc back · ↑↓/kj · ${recover}`;
    if (f.type === "action") return `enter/tab run · ↑↓/kj · g scope · ${recover}`;
    const scope = "g scope";
    switch (f.type) {
      case "boolean":
        return `enter/tab toggle · space toggle · ↑↓/kj · / search · ${scope} · ${recover}`;
      case "enum":
        return `enter/tab choose · space cycle · ↑↓/kj · ${scope} · ${recover}`;
      case "multiselect":
        return `enter/tab choose · ↑↓/kj · ${scope} · ${recover}`;
      case "order":
        return `enter/tab reorder · ↑↓/kj · ${scope} · ${recover}`;
      case "model":
        return `enter/tab pick · ↑↓/kj · ${scope} · ${recover}`;
      default:
        return `enter/tab edit · ↑↓/kj · / search · ${scope} · ${recover}`;
    }
  }

  render(width: number): string[] {
    this.renderWidth = width;
    const inner = boxInnerWidth(width);
    const body: string[] = [];

    if (this.mode === "search" && this.searchInput) {
      for (const l of this.searchInput.render(Math.max(8, inner - 2))) body.push(this.exactRow(` ${l}`, inner));
    }

    const visible = this.visibleRows();
    // Reserve room below the window when an inline editor/picker is open.
    const overlayReserve = this.mode === "input" || this.mode === "model" ? 7 : 0;
    // RELATIVE height: about half the terminal — a dialog, not a takeover —
    // but never taller than fits (term - 7 of chrome) and never below 3 rows.
    const term = this.terminalRows();
    const maxRows = Math.max(3, Math.min(Math.floor(term / 2), term - 7) - overlayReserve);
    this.clampScroll(visible.length, maxRows);

    if (this.scroll > 0) body.push(this.exactRow(dim(`  ↑ ${this.scroll} more`), inner));

    const end = Math.min(visible.length, this.scroll + maxRows);
    for (let i = this.scroll; i < end; i++) {
      const row = visible[i]!;
      const selected = i === this.cursor && this.mode !== "search";
      body.push(this.renderRow(row, selected, inner));
      if (this.mode === "input" && this.edit && this.edit.row.id === row.id) {
        body.push(...this.renderEdit(inner));
      }
      if (this.mode === "model" && this.picker && this.picker.row.id === row.id) {
        body.push(...this.renderPicker(inner));
      }
    }

    const below = visible.length - end;
    if (below > 0) body.push(this.exactRow(dim(`  ↓ ${below} more`), inner));

    if (this.toast) body.push(this.exactRow(`  ${bold(this.toast)}`, inner));
    body.push(this.exactRow(dim(`  ${this.hintLine()}`), inner));
    this.toast = null; // shown for exactly one render
    return frameOverlay(body, width, {
      // Scope lives in the TITLE — it's global state, not a list row.
      // Pages breadcrumb into it: ` unipi settings › serpapi — global [g] `.
      title: bold(` unipi settings${this.pageStack.map((p) => ` › ${p.label}`).join("")} — ${this.scope} [g] `),
      borderFg: (t: string) => overlayTheme.fg("borderMuted", t),
    });
  }
}
