/**
 * Settings field schema — what modules declare so the /unipi:settings hub can
 * render their settings automatically.
 *
 * A module registers ONE SettingsDefinition (engine.ts) carrying `schema`:
 * sections → fields, each field a dot-path key into the module's settings
 * object. The hub maps field types to widgets:
 *
 *   boolean → on/off cycle          enum → option cycle (labels shown)
 *   string  → Input submenu         number → Input submenu (validated)
 *   secret  → Input submenu, value masked in the list (API keys etc.)
 */

export type SettingsField =
  | { readonly key: string; readonly type: "boolean"; readonly label: string; readonly description?: string }
  | {
      readonly key: string;
      readonly type: "enum";
      readonly label: string;
      readonly description?: string;
      /** Cycle order; entries are raw values or value:label pairs. */
      readonly options: readonly (string | { readonly value: string; readonly label: string })[];
      /**
       * When true the field also accepts a free-text value: the cycle ends with
       * `custom…`, and Space on any position jumps to custom + opens the inline
       * editor prefilled with the current raw value.
       */
      readonly allowCustom?: boolean;
      /** Shown as a dim `ⓘ` line under the inline editor's input. */
      readonly hint?: string;
      /** Gate custom input on submit; returns an error message or null. */
      readonly validate?: (raw: string) => string | null;
    }
  | {
      readonly key: string;
      readonly type: "string";
      readonly label: string;
      readonly description?: string;
      /** Shown when the value is "" or unset (e.g. "inherit (session model)"). */
      readonly emptyLabel?: string;
      /** Shown as a dim `ⓘ` line under the inline editor's input. */
      readonly hint?: string;
      /** Gate raw input on submit; returns an error message or null. */
      readonly validate?: (raw: string) => string | null;
    }
  | {
      readonly key: string;
      readonly type: "number";
      readonly label: string;
      readonly description?: string;
      readonly min?: number;
      readonly max?: number;
      /** Shown when the value is 0 (e.g. "∞ none" for timeouts). */
      readonly zeroLabel?: string;
      /** Shown as a dim `ⓘ` line under the inline editor's input. */
      readonly hint?: string;
      /** Gate raw input on submit; returns an error message or null. */
      readonly validate?: (raw: string) => string | null;
    }
  | {
      readonly key: string;
      readonly type: "secret";
      readonly label: string;
      readonly description?: string;
      /** Shown when unset (masking wins when a value exists). */
      readonly emptyLabel?: string;
      /** Shown as a dim `ⓘ` line under the inline editor's input. */
      readonly hint?: string;
      /** Gate raw input on submit; returns an error message or null. */
      readonly validate?: (raw: string) => string | null;
    }
  | {
      /** Model id ("provider/model") — searchable 5-row picker in the hub. */
      readonly key: string;
      readonly type: "model";
      readonly label: string;
      readonly description?: string;
      /** Restrict the picker to one provider's catalog (empty = all). */
      readonly provider?: string;
      /** Shown when "" (e.g. "inherit (session model)"). */
      readonly emptyLabel?: string;
      /**
       * Filter the registry catalog by the model's declared `input` array:
       * "text" → must include "text"; "image-input" → must include "image".
       */
      readonly capability?: "text" | "image-input";
      /** When set, the picker lists ONLY these ids (+ custom…), not the catalog. */
      readonly presets?: readonly string[];
      /**
       * Per-provider preset lists, keyed by the sibling `providerKey` field's
       * value. A matched key replaces the catalog; "inherit" providers (no
       * match) keep the capability-filtered catalog.
       */
      readonly presetsByProvider?: Record<string, readonly string[]>;
      /** When set, the picker's FIRST entry is this label and picks "". */
      readonly emptyOption?: string;
      /** Sibling key (same namespace) whose value selects a presetsByProvider list. */
      readonly providerKey?: string;
      /** Extra catalog filter (e.g. image's looksLikeImageGenerator); no presets. */
      readonly filter?: (entry: { readonly id: string; readonly input: string[] }) => boolean;
    }
  | {
      /** Nested config page (Enter/Tab opens; Esc pops). Fields use FULL keys. */
      readonly key: string;
      readonly type: "page";
      readonly label: string;
      readonly description?: string;
      /**
       * Static sections, or a getter resolved at openPage time so registry-
       * driven pages (info groups, footer segments) stay live.
       */
      readonly sections: readonly SettingsSection[] | (() => readonly SettingsSection[]);
    }
  | {
      /** Runs a named command (registered via core registerCommandRunner). */
      readonly key: string;
      readonly type: "action";
      readonly label: string;
      readonly description?: string;
      readonly command: string;
    }
  | {
      /**
       * Set of string options — value is string[]. The picker shows [x]/[ ]
       * checkboxes; toggling writes instantly and keeps the list open.
       */
      readonly key: string;
      readonly type: "multiselect";
      readonly label: string;
      readonly description?: string;
      readonly options: readonly (string | { readonly value: string; readonly label: string })[];
      /** Shown when the selection is empty (e.g. "all platforms"). */
      readonly emptyLabel?: string;
    }
  | {
      /**
       * Ordered subset of items — value is string[] in display order. The
       * editor lists the current order; Shift+J/K (alt+↑/↓) shift an item
       * and write instantly.
       */
      readonly key: string;
      readonly type: "order";
      readonly label: string;
      readonly description?: string;
      /** The full item universe in canonical order. */
      readonly items: () => readonly { readonly value: string; readonly label: string }[];
    };

export interface SettingsSection {
  /** Section heading in the hub (e.g. "Judge", "Badge"). */
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly SettingsField[];
  /**
   * Progressive disclosure: collapsed behind the namespace's "▸ Advanced"
   * toggle. Search still finds these fields (filter reveals them).
   */
  readonly advanced?: boolean;
}

/** Read the value at a dot-path key from a settings object. */
export function getField(settings: Record<string, unknown>, key: string): unknown {
  let current: unknown = settings;
  for (const segment of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Set the value at a dot-path key, returning a NEW object (no mutation). */
export function setField(
  settings: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const segments = key.split(".");
  const clone: Record<string, unknown> = { ...settings };
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const next = cursor[segment];
    cursor[segment] = typeof next === "object" && next !== null && !Array.isArray(next)
      ? { ...(next as Record<string, unknown>) }
      : {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
  return clone;
}

/** Normalize an enum option entry to {value, label}. */
export function enumOption(option: string | { value: string; label: string }): { value: string; label: string } {
  return typeof option === "string" ? { value: option, label: option } : option;
}

/** Format a field's current value for the list display. */
export function formatFieldValue(field: SettingsField, value: unknown): string {
  switch (field.type) {
    case "boolean":
      return value === true ? "on" : value === false ? "off" : "unset";
    case "enum": {
      if (value === undefined || value === null) return "unset";
      const match = field.options.map(enumOption).find((o) => o.value === String(value));
      if (match) return match.label;
      // Custom value on an allowCustom enum — visible state marker.
      return field.allowCustom ? `⚙ ${String(value)}` : String(value);
    }
    case "secret": {
      // Masking wins whenever a value exists.
      if (typeof value === "string" && value.length > 0) return "••••••";
      return field.emptyLabel ?? "unset";
    }
    case "number":
      if (value === 0 && field.type === "number" && field.zeroLabel) return field.zeroLabel;
      return value === undefined || value === null ? "unset" : String(value);
    case "multiselect": {
      const chosen = Array.isArray(value) ? value.map(String) : [];
      if (chosen.length === 0) return field.emptyLabel ?? "none";
      const labels = field.options.map(enumOption);
      return chosen
        .map((v) => labels.find((o) => o.value === v)?.label ?? v)
        .join(", ");
    }
    case "order": {
      const ids = Array.isArray(value) ? value.map(String) : [];
      if (ids.length === 0) return "unset";
      const universe = field.items();
      const labels = ids.map((id) => universe.find((i) => i.value === id)?.label ?? id);
      return labels.slice(0, 3).join(" › ") + (labels.length > 3 ? " …" : "");
    }
    default: {
      if ((value === undefined || value === null || value === "") && "emptyLabel" in field && field.emptyLabel) {
        return field.emptyLabel;
      }
      return value === undefined || value === null ? "unset" : String(value);
    }
  }
}

/** True when a field's raw value is NOT one of its enum options (a custom value). */
export function isCustomEnumValue(field: SettingsField, value: unknown): boolean {
  if (field.type !== "enum") return false;
  if (value === undefined || value === null) return false;
  return !field.options.map(enumOption).some((o) => o.value === String(value));
}

/** Parse raw input text for a field; returns undefined when invalid. */
export function parseFieldValue(field: SettingsField, raw: string): unknown {
  const trimmed = raw.trim();
  switch (field.type) {
    case "string":
    case "secret":
    case "model":
      return trimmed;
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || trimmed === "") return undefined;
      if (field.min !== undefined && n < field.min) return undefined;
      if (field.max !== undefined && n > field.max) return undefined;
      return n;
    }
    default:
      return undefined;
  }
}
