/**
 * The /unipi:settings hub — every registered module's settings in one panel.
 *
 * One flat, searchable SettingsList (pi-tui): a scope selector at the top,
 * then every field of every registered module, grouped with section headers.
 * Booleans and enums cycle in place; strings/numbers/secrets open an inline
 * Input editor. Writes go through the engine (defaults ⊕ global ⊕ project),
 * so a field written here is read by the module on its next settings load.
 *
 * Keyboard:
 *   ↑/↓ move · / search · Enter edit/cycle · Esc close (or leave editor)
 *   g toggle write scope global/project (project disabled where unsupported)
 */

import { Input, SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { frameOverlay, OverlayTheme } from "../../tui-overlay.js";
import { boxInnerWidth } from "../../tui-width.js";
import {
  enumOption,
  formatFieldValue,
  getField,
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
}

const overlayTheme = new OverlayTheme();

interface HubFieldItem {
  readonly namespace: string;
  readonly field: SettingsField;
}

export class SettingsHub {
  private readonly cwd: string;
  private readonly onChanged?: (namespace: string) => void;
  /** Called when the user closes the panel (Esc). Wire to the overlay's done(). */
  onClose: () => void = () => {};
  private scope: SettingsScope = "global";
  private list!: SettingsList;
  /** id → {namespace, field} for the flat item list. */
  private readonly items = new Map<string, HubFieldItem>();
  /** Live values per namespace (read once at open; writes update locally). */
  private readonly values = new Map<string, Record<string, unknown>>();

  constructor(deps: SettingsHubDeps) {
    this.cwd = deps.cwd;
    this.onChanged = deps.onChanged;
    this.build();
  }

  private valueOf(namespace: string): Record<string, unknown> {
    let v = this.values.get(namespace);
    if (!v) {
      v = getSettings(namespace, this.cwd);
      this.values.set(namespace, v);
    }
    return v;
  }

  private build(): void {
    this.items.clear();
    const defs = listSettingsDefinitions().filter((d) => d.schema && d.schema.length > 0);
    const settingItems: SettingItem[] = [];

    // Scope selector first.
    const projectAllowed = defs.some((d) => d.projectOverrides !== false);
    settingItems.push({
      id: "::scope",
      label: "Write scope",
      description: projectAllowed
        ? "Where edits land: global (~/.unipi/config) or project (./.unipi/config override)"
        : "Where edits land. Project overrides are not supported by any registered module.",
      currentValue: this.scope,
      values: projectAllowed ? ["global", "project"] : ["global"],
    });

    for (const def of defs) {
      const layers = settingsLayers(def.namespace, this.cwd);
      const layerTag = `${layers.global ? "G" : "-"}${layers.project ? "P" : "-"}`;
      for (const section of def.schema!) {
        settingItems.push({
          id: `${def.namespace}::${section.title}::header`,
          label: `${def.label} — ${section.title} [${layerTag}]`,
          description: section.description ?? `${def.namespace} · ${section.title}`,
          currentValue: "",
          values: ["—"],
        });
        for (const field of section.fields) {
          const id = `${def.namespace}::${field.key}`;
          this.items.set(id, { namespace: def.namespace, field });
          const value = getField(this.valueOf(def.namespace), field.key);
          settingItems.push(this.toItem(id, def.namespace, field, value));
        }
      }
    }

    this.list = new SettingsList(
      settingItems,
      18,
      {
        label: (text, selected) => (selected ? overlayTheme.bold(text) : text),
        value: (text, selected) =>
          selected ? overlayTheme.bold(text) : overlayTheme.fg("textMuted", text),
        description: (text) => overlayTheme.fg("textMuted", text),
        cursor: "› ",
        hint: (text) => overlayTheme.fg("textMuted", text),
      },
      (id, newValue) => this.onChange(id, newValue),
      () => this.onClose(),
      { enableSearch: true },
    );
  }

  private toItem(id: string, namespace: string, field: SettingsField, value: unknown): SettingItem {
    const base = {
      id,
      label: `  ${field.label}`,
      description: field.description,
      currentValue: formatFieldValue(field, value),
    };
    if (field.type === "boolean") {
      return { ...base, values: value === true ? ["on", "off"] : ["off", "on"] };
    }
    if (field.type === "enum") {
      const opts = field.options.map(enumOption);
      const start = opts.findIndex((o) => o.value === String(value));
      const ordered = start > 0 ? [opts[start]!, ...opts.slice(0, start), ...opts.slice(start + 1)] : opts;
      return { ...base, values: ordered.map((o) => o.label) };
    }
    return {
      ...base,
      submenu: (currentValue, done) => {
        const input = new Input({ prompt: `${field.label}: ` });
        const isSecret = field.type === "secret";
        if (!isSecret && currentValue !== "unset" && currentValue !== "") input.setValue(currentValue);
        input.onSubmit = (raw) => {
          const parsed = parseFieldValue(field, raw);
          if (parsed === undefined) {
            done();
            return;
          }
          this.applyChange(namespace, field, parsed);
          done(formatFieldValue(field, parsed));
        };
        input.onEscape = () => done();
        return input;
      },
    };
  }
  private onChange(id: string, newValue: string): void {
    if (id === "::scope") {
      this.scope = newValue === "project" ? "project" : "global";
      this.list.updateValue(id, this.scope);
      return;
    }
    const entry = this.items.get(id);
    if (!entry) return;
    const { namespace, field } = entry;

    if (field.type === "boolean") {
      this.applyChange(namespace, field, newValue === "on");
      return;
    }
    if (field.type === "enum") {
      const match = field.options.map(enumOption).find((o) => o.label === newValue);
      if (match) this.applyChange(namespace, field, match.value);
      return;
    }
    // string/number/secret resolve through their submenu, not cycle.
  }

  private applyChange(namespace: string, field: SettingsField, value: unknown): void {
    const current = this.valueOf(namespace);
    const next = setField(current, field.key, value);
    this.values.set(namespace, next);
    setSettings(namespace, setField({}, field.key, value), this.scope, this.cwd);
    this.onChanged?.(namespace);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const inner = boxInnerWidth(width);
    const body: string[] = [
      overlayTheme.bold("  ⚙  unipi settings"),
      overlayTheme.fg("textMuted", "  ↑↓ move · / search · enter edit · esc close"),
      "",
      ...this.list.render(inner),
    ];
    return frameOverlay(body, width, {
      title: overlayTheme.bold(" unipi settings "),
      borderFg: (t: string) => overlayTheme.fg("borderMuted", t),
    });
  }
}
