/**
 * The /unipi:settings hub — every registered module's settings in one panel.
 *
 * Interaction spec (user, 2026-09-22; instant-apply, no staged state):
 *   ↑/k ↓/j   move
 *   /         search (esc exits search; esc again closes)
 *   Space     boolean → toggle · string/number/secret → inline input below the
 *             row (prefilled) · enum(allowCustom) → jump to custom + input ·
 *             model → searchable picker
 *   Tab       boolean → toggle · enum → cycle (allowCustom ends with custom…)
 *             · scope row → switch global↔project
 *   Enter     inside an input/picker: save/pick (instant write)
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
import { loadModelCatalog } from "./catalog.js";
import {
  enumOption,
  formatFieldValue,
  getField,
  isCustomEnumValue,
  parseFieldValue,
  setField,
  type SettingsField,
} from "./schema.js";
import {
  getSettings,
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
  /** Terminal rows for viewport sizing (tests inject; default stdout.rows). */
  readonly terminalRows?: () => number;
}

type Mode = "list" | "search" | "input" | "model";

interface Row {
  readonly kind: "scope" | "header" | "field";
  readonly id: string;
  readonly label: string;
  readonly namespace?: string;
  /** Module label + section title — search haystack parts ("Judge", "Long-Horizon"). */
  readonly context?: string;
  readonly field?: SettingsField;
  readonly layerTag?: string;
}

const PAGE_ROWS = 10;
const overlayTheme = new OverlayTheme();
const dim = (t: string) => overlayTheme.fg("textMuted", t);
const bold = (t: string) => overlayTheme.bold(t);

/** Cycle a value through an enum's options (allowCustom appends custom…). */
export function nextEnumValue(field: SettingsField, current: unknown): { value: unknown; label: string } | null {
  if (field.type !== "enum") return null;
  const opts = field.options.map(enumOption);
  const cur = String(current ?? "");
  const custom = field.allowCustom === true && isCustomEnumValue(field, current);
  const order = custom ? [...opts, { value: "\u0000custom", label: "custom…" }] : field.allowCustom === true ? [...opts, { value: "\u0000custom", label: "custom…" }] : opts;
  const idx = order.findIndex((o) => o.value === cur);
  const next = order[(idx + 1 + order.length) % order.length]!;
  return { value: next.value === "\u0000custom" ? next.value : next.value, label: next.label };
}

export class SettingsHub {
  onClose: () => void = () => {};
  private readonly cwd: string;
  private readonly onChanged?: (namespace: string) => void;
  private readonly catalog: () => string[];
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
  private picker: { row: Row; input: Input; options: string[]; selected: number } | null = null;
  private renderWidth = 80;
  /** Viewport: index of the first visible row. */
  private scroll = 0;
  private readonly terminalRowsFn: () => number;

  constructor(deps: SettingsHubDeps) {
    this.cwd = deps.cwd;
    this.onChanged = deps.onChanged;
    this.catalog = deps.modelCatalog ?? loadModelCatalog;
    this.terminalRowsFn = deps.terminalRows ?? (() => process.stdout.rows ?? 40);
    this.buildRows();
  }

  private valueOf(namespace: string): Record<string, unknown> {
    let v = this.values.get(namespace);
    if (!v) {
      v = getSettings(namespace, this.cwd);
      this.values.set(namespace, v);
    }
    return v;
  }

  private buildRows(): void {
    const defs = listSettingsDefinitions().filter((d) => d.schema && d.schema.length > 0);
    const rows: Row[] = [{
      kind: "scope", id: "::scope", label: "Write scope",
    }];
    for (const def of defs) {
      const layers = settingsLayers(def.namespace, this.cwd);
      const tag = `${layers.global ? "G" : "-"}${layers.project ? "P" : "-"}`;
      for (const section of def.schema!) {
        rows.push({
          kind: "header", id: `${def.namespace}::${section.title}`,
          label: `${def.label} — ${section.title}`, layerTag: tag,
        });
        for (const field of section.fields) {
          rows.push({
            kind: "field", id: `${def.namespace}::${field.key}`,
            label: field.label, namespace: def.namespace, field,
            context: `${def.label} ${section.title}`,
          });
        }
      }
    }
    this.rows = rows;
  }

  // ── filtering ───────────────────────────────────────────────────────────
  private visibleRows(): Row[] {
    if (!this.filter) return this.rows;
    // Word-wise AND: every word must appear somewhere in the row's haystack
    // (field label, module label, section title, namespace, description) —
    // so "judge model" matches Long-Horizon's Judge section's Model field.
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.rows;
    return this.rows.filter((r) => {
      if (r.kind === "field") {
        const haystack = [
          r.label,
          r.context ?? "",
          r.namespace ?? "",
          r.field?.description ?? "",
        ].join(" ").toLowerCase();
        return words.every((w) => haystack.includes(w));
      }
      if (r.kind === "scope") {
        return words.every((w) => "write scope".includes(w));
      }
      return false;
    });
  }

  private currentRow(): Row | undefined {
    return this.visibleRows()[this.cursor];
  }

  // ── writes ──────────────────────────────────────────────────────────────
  private applyChange(row: Row, value: unknown): void {
    if (!row.namespace || !row.field) return;
    const next = setField(this.valueOf(row.namespace), row.field.key, value);
    this.values.set(row.namespace, next);
    setSettings(row.namespace, setField({}, row.field.key, value), this.scope, this.cwd);
    this.onChanged?.(row.namespace);
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
      this.cursor = Math.max(0, Math.min(visible.length - 1, this.cursor + delta));
    };
    if (matchesKey(data, Key.up) || ch === "k") return move(-1);
    if (matchesKey(data, Key.down) || ch === "j") return move(1);
    if (matchesKey(data, Key.pageUp)) return move(-PAGE_ROWS);
    if (matchesKey(data, Key.pageDown)) return move(PAGE_ROWS);
    if (matchesKey(data, Key.home)) {
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.cursor = Math.max(0, visible.length - 1);
      return;
    }
    if (matchesKey(data, Key.slash) || ch === "/") {
      this.mode = "search";
      this.searchInput = new Input({ prompt: "/" });
      return;
    }
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.space)) {
      const row = this.currentRow();
      if (!row) return;
      const isTab = matchesKey(data, Key.tab);
      if (row.kind === "scope") {
        if (isTab) this.toggleScope();
        return;
      }
      if (row.kind !== "field" || !row.field || !row.namespace) return;
      const value = getField(this.valueOf(row.namespace), row.field.key);
      return isTab ? this.handleTab(row, value) : this.handleSpace(row, value);
    }
  }

  private handleTab(row: Row, value: unknown): void {
    const field = row.field!;
    if (field.type === "boolean") {
      this.applyChange(row, value !== true);
      return;
    }
    if (field.type === "enum") {
      const opts = field.options.map(enumOption);
      const order = field.allowCustom === true ? [...opts, { value: "\u0000custom", label: "custom…" }] : opts;
      const cur = String(value ?? "");
      const idx = order.findIndex((o) => o.value === cur);
      const next = order[(idx + 1 + order.length) % order.length]!;
      if (next.value !== "\u0000custom") this.applyChange(row, next.value);
      // Landing ON custom… opens the editor (prefilled) rather than guessing.
      else this.openEdit(row);
    }
    if (field.type === "model") this.openPicker(row);
  }

  private handleSpace(row: Row, value: unknown): void {
    const field = row.field!;
    switch (field.type) {
      case "boolean":
        this.applyChange(row, value !== true);
        return;
      case "string":
      case "number":
      case "secret":
        this.openEdit(row);
        return;
      case "enum":
        if (field.allowCustom === true) this.openEdit(row);
        return; // plain enums ignore Space
      case "model":
        this.openPicker(row);
        return;
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
    if (field.type === "model" && field.provider) options = options.filter((id) => id.startsWith(`${field.provider}/`));
    const input = new Input({ prompt: "search: " });
    const start = getField(this.valueOf(row.namespace!), field.key);
    if (typeof start === "string" && start) {
      input.setValue(start);
      input.handleInput("\x1b[F");
    }
    this.picker = { row, input, options, selected: 0 };
    this.mode = "model";
  }

  private pickerFiltered(): string[] {
    const p = this.picker;
    if (!p) return [];
    const q = p.input.getValue().trim().toLowerCase();
    const base = q ? p.options.filter((id) => id.toLowerCase().includes(q)) : p.options;
    return base;
  }

  private handleInputPicker(data: string): void {
    const p = this.picker;
    if (!p) { this.mode = "list"; return; }
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.picker = null;
      this.mode = "list";
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      const options = this.pickerFiltered();
      const pick = options[p.selected];
      if (pick !== undefined) this.applyChange(p.row, pick);
      this.picker = null;
      this.mode = "list";
      return;
    }
    if (matchesKey(data, Key.up)) {
      const n = this.pickerFiltered().length;
      if (n > 0) p.selected = (p.selected - 1 + n) % n;
      return;
    }
    if (matchesKey(data, Key.down)) {
      const n = this.pickerFiltered().length;
      if (n > 0) p.selected = (p.selected + 1) % n;
      return;
    }
    // k/j are TEXT here (model ids contain them) — arrows walk the list.
    p.input.handleInput(data);
    p.selected = 0; // any text change resets selection
  }

  private handleInputSearch(data: string): void {
    const input = this.searchInput;
    if (!input) { this.mode = "list"; return; }
    if (matchesKey(data, Key.escape) || data === "\x1b") {
      this.searchInput = null;
      this.filter = "";
      this.mode = "list";
      this.cursor = 0;
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      this.filter = input.getValue();
      this.mode = "list";
      this.cursor = 0;
      return;
    }
    input.handleInput(data);
    this.filter = input.getValue(); // live filtering
    this.cursor = 0;
  }

  private handleInputEdit(data: string): void {
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
   * then styled per span. Always exactly `inner` cells.
   */
  private rowColumns(
    cursor: string,
    label: string,
    value: string,
    inner: number,
    selected: boolean,
  ): string {
    const valW = visibleWidth(value);
    const room = Math.max(0, inner - 2 - valW - 2);
    const labelT = truncateToWidth(label, room, "…");
    const gap = Math.max(1, inner - 2 - visibleWidth(labelT) - valW);
    const labelStyled = selected ? bold(labelT) : labelT;
    const valueStyled = selected ? bold(value) : dim(value);
    return `${cursor}${labelStyled}${" ".repeat(gap)}${valueStyled}`;
  }

  private renderRow(row: Row, selected: boolean, inner: number): string {
    const cursor = selected ? "› " : "  ";
    if (row.kind === "header") {
      const tag = row.layerTag ? ` [${row.layerTag}]` : "";
      return this.exactRow(dim(`  ${row.label}${tag}`), inner);
    }
    if (row.kind === "scope") {
      return this.exactRow(this.rowColumns(cursor, "  Write scope", `${this.scope} [tab]`, inner, selected), inner);
    }
    const field = row.field!;
    const value = getField(this.valueOf(row.namespace!), field.key);
    const display = formatFieldValue(field, value);
    const hint =
      field.type === "boolean" ? " [space]" :
      field.type === "enum" ? (field.allowCustom ? " [tab/space]" : " [tab]") :
      field.type === "model" ? " [space]" : " [space]";
    return this.exactRow(
      this.rowColumns(cursor, `  ${row.label}`, `${display}${hint}`, inner, selected),
      inner,
    );
  }

  private renderEdit(inner: number): string[] {
    if (!this.edit) return [];
    const width = Math.max(8, inner - 4);
    const out = this.edit.input.render(width).map((l) => this.exactRow(`  ${l}`, inner));
    if (this.edit.error) out.push(this.exactRow(dim(`  ⚠ ${this.edit.error}`), inner));
    return out;
  }

  private renderPicker(inner: number): string[] {
    const p = this.picker;
    if (!p) return [];
    const width = Math.max(8, inner - 4);
    const out: string[] = [];
    out.push(this.exactRow(`  ${p.input.render(width).join("")}`, inner));
    const options = this.pickerFiltered();
    const start = Math.min(p.selected, Math.max(0, options.length - 5));
    for (let i = start; i < Math.min(start + 5, options.length); i++) {
      const sel = i === p.selected;
      const label = truncateToWidth(`  ${options[i]}`, width, "…");
      out.push(this.exactRow(sel ? `  ${bold(label)}` : `  ${dim(label)}`, inner));
    }
    // Pad to exactly 5 rows so the panel never jumps.
    for (let i = options.length - start; i < 5; i++) out.push(this.exactRow(`  ${dim("  ·")}`, inner));
    out.push(this.exactRow(dim("  enter pick · esc cancel"), inner));
    return out;
  }

  private clampScroll(len: number, maxRows: number): void {
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor > this.scroll + maxRows - 1) this.scroll = this.cursor - maxRows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, len - maxRows)));
  }

  private hintLine(): string {
    if (this.mode === "search") return "type to filter · enter apply · esc clear";
    if (this.mode === "input") return "enter save · esc cancel";
    if (this.mode === "model") return "↑↓/kj pick · enter select · esc cancel";
    const row = this.currentRow();
    if (row?.kind === "scope") return "tab switch global/project · esc close";
    const f = row?.field;
    if (!f) return "↑↓/kj move · / search · esc close";
    switch (f.type) {
      case "boolean":
        return "space/tab toggle · ↑↓/kj move · / search · esc close";
      case "enum":
        return f.allowCustom
          ? "tab cycle · space custom · ↑↓/kj move · esc close"
          : "tab cycle · ↑↓/kj move · / search · esc close";
      case "model":
        return "space/tab pick model · ↑↓/kj move · esc close";
      default:
        return "space edit · ↑↓/kj move · / search · esc close";
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
    const maxRows = Math.max(4, this.terminalRows() - 7 - overlayReserve);
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

    body.push(this.exactRow(dim(`  ${this.hintLine()}`), inner));
    return frameOverlay(body, width, {
      title: bold(" unipi settings "),
      borderFg: (t: string) => overlayTheme.fg("borderMuted", t),
    });
  }
}
