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

import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
}

type Mode = "list" | "search" | "input" | "model";

interface Row {
  readonly kind: "scope" | "header" | "field";
  readonly id: string;
  readonly label: string;
  readonly namespace?: string;
  readonly field?: SettingsField;
  readonly layerTag?: string;
}

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

  constructor(deps: SettingsHubDeps) {
    this.cwd = deps.cwd;
    this.onChanged = deps.onChanged;
    this.catalog = deps.modelCatalog ?? loadModelCatalog;
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
          });
        }
      }
    }
    this.rows = rows;
  }

  // ── filtering ───────────────────────────────────────────────────────────
  private visibleRows(): Row[] {
    if (!this.filter) return this.rows;
    const f = this.filter.toLowerCase();
    return this.rows.filter((r) => {
      if (r.kind === "field") {
        return (
          r.label.toLowerCase().includes(f) ||
          (r.namespace ?? "").includes(f) ||
          (r.field?.description ?? "").toLowerCase().includes(f)
        );
      }
      return r.kind === "scope" && "write scope".includes(f);
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

  private handleInputList(data: string): void {
    const visible = this.visibleRows();
    switch (data) {
      case "\x1b[A": case "k":
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      case "\x1b[B": case "j":
        this.cursor = Math.min(visible.length - 1, this.cursor + 1);
        return;
      case "/":
        this.mode = "search";
        this.searchInput = new Input({ prompt: "/" });
        return;
      case "\x1b":
        this.onClose();
        return;
      case "\t":
      case " ": {
        const row = this.currentRow();
        if (!row) return;
        if (row.kind === "scope") {
          if (data === "\t") this.toggleScope();
          return;
        }
        if (row.kind !== "field" || !row.field || !row.namespace) return;
        const value = getField(this.valueOf(row.namespace), row.field.key);
        if (data === "\t") return this.handleTab(row, value);
        return this.handleSpace(row, value);
      }
      default:
        return;
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
    if (data === "\x1b") {
      this.picker = null;
      this.mode = "list";
      return;
    }
    if (data === "\r") {
      const options = this.pickerFiltered();
      const pick = options[p.selected];
      if (pick !== undefined) this.applyChange(p.row, pick);
      this.picker = null;
      this.mode = "list";
      return;
    }
    if (data === "\x1b[A" || data === "k") {
      const n = this.pickerFiltered().length;
      if (n > 0) p.selected = (p.selected - 1 + n) % n;
      return;
    }
    if (data === "\x1b[B" || data === "j") {
      const n = this.pickerFiltered().length;
      if (n > 0) p.selected = (p.selected + 1) % n;
      return;
    }
    p.input.handleInput(data);
    p.selected = 0; // any text change resets selection
  }

  private handleInputSearch(data: string): void {
    const input = this.searchInput;
    if (!input) { this.mode = "list"; return; }
    if (data === "\x1b") {
      this.searchInput = null;
      this.filter = "";
      this.mode = "list";
      this.cursor = 0;
      return;
    }
    if (data === "\r") {
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

  render(width: number): string[] {
    this.renderWidth = width;
    const inner = boxInnerWidth(width);
    const body: string[] = [bold("  ⚙  unipi settings")];

    if (this.mode === "search" && this.searchInput) {
      body.push(...this.searchInput.render(inner).map((l) => ` ${l}`), "");
    }

    const visible = this.visibleRows();
    const rows: string[] = [];
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i]!;
      const selected = i === this.cursor && this.mode !== "search";
      rows.push(this.renderRow(row, selected, inner));
      if (this.mode === "input" && this.edit && this.edit.row.id === row.id) {
        rows.push(...this.renderEdit(inner));
      }
      if (this.mode === "model" && this.picker && this.picker.row.id === row.id) {
        rows.push(...this.renderPicker(inner));
      }
    }
    body.push(...rows);
    body.push("");
    body.push(dim("  ↑↓/kj move · space toggle/edit · tab cycle · / search · esc close"));
    return frameOverlay(body, width, {
      title: bold(" unipi settings "),
      borderFg: (t: string) => overlayTheme.fg("borderMuted", t),
    });
  }

  private renderRow(row: Row, selected: boolean, width: number): string {
    const cursor = selected ? "› " : "  ";
    if (row.kind === "header") {
      const tag = row.layerTag ? dim(` [${row.layerTag}]`) : "";
      return `${cursor}${dim(row.label)}${tag}`;
    }
    if (row.kind === "scope") {
      return `${cursor}${selected ? bold(row.label) : row.label}${padValue(width, row.label, this.scope + dim(" [tab]"))}`;
    }
    const field = row.field!;
    const value = getField(this.valueOf(row.namespace!), field.key);
    const display = formatFieldValue(field, value);
    const hint =
      field.type === "boolean" ? " [space]" :
      field.type === "enum" ? (field.allowCustom ? " [tab/space]" : " [tab]") :
      field.type === "model" ? " [space]" : " [space]";
    const valueCol = `${display}${dim(hint)}`;
    return `${cursor}${selected ? bold(`  ${row.label}`) : `  ${row.label}`}${padValue(width, `  ${row.label}`, valueCol, selected)}`;
  }

  private renderEdit(width: number): string[] {
    if (!this.edit) return [];
    const lines = this.edit.input.render(width - 4).map((l) => `   ${l}`);
    return this.edit.error ? [...lines, dim(`   ⚠ ${this.edit.error}`)] : lines;
  }

  private renderPicker(width: number): string[] {
    const p = this.picker;
    if (!p) return [];
    const box = Math.max(20, Math.min(width - 6, 76));
    const out: string[] = [];
    out.push(`   ${dim("┌")} ${p.input.render(box - 6).join("")} ${dim("┐")}`);
    const options = this.pickerFiltered();
    const start = Math.min(p.selected, Math.max(0, options.length - 5));
    for (let i = start; i < Math.min(start + 5, options.length); i++) {
      const sel = i === p.selected;
      const id = truncateToWidth(`  ${options[i]}`, box - 6, "");
      out.push(`   ${dim("│")} ${sel ? bold(id) : dim(id)}${" ".repeat(Math.max(0, box - 8 - visibleWidth(id)))} ${dim("│")}`);
    }
    // Pad to exactly 5 visible rows so the panel never jumps.
    for (let i = options.length - start; i < 5; i++) {
      out.push(`   ${dim("│")}${" ".repeat(Math.max(0, box - 4))}${dim("│")}`);
    }
    out.push(`   ${dim("└")} enter pick · esc cancel ${dim("┘")}`);
    return out;
  }
}

/** Right-align a value column against the label within width. */
function padValue(width: number, label: string, value: string, selected = false): string {
  const used = 2 + visibleWidth(label);
  const valueW = visibleWidth(value);
  const space = Math.max(1, width - used - valueW - 1);
  return `${" ".repeat(space)}${selected ? bold(value) : value}`;
}
