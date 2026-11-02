/**
 * Settings snapshot — the settings catalog published to disk for OTHER
 * processes (the unipi-host serves it to the app's Settings → UniPi screen;
 * docs: `~/.unipi/config/settings-schema.json`).
 *
 * `buildSettingsSnapshot()` flattens the live registry (engine.ts) into plain
 * JSON: getters are resolved (order items, page sections), functions are
 * dropped (`validate` → `validated: true`, model `filter` → `filtered: true`),
 * and anything that throws while reading is skipped — a broken getter in one
 * module must never blank the whole catalog.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listSettingsDefinitions, type SettingsDefinition } from "./engine.js";
import { unipiConfigRoot } from "./paths.js";
import { enumOption, type SettingsField, type SettingsSection } from "./schema.js";

export interface SettingsSnapshotNamespace {
  readonly namespace: string;
  readonly label: string;
  readonly defaults: Record<string, unknown>;
  readonly projectOverrides: boolean;
  /** The module mirrors writes into another program's config (an `onSet` hook) — the host cannot run it, so the app must not write these. */
  readonly mirrored: boolean;
  readonly sections: readonly SettingsSnapshotSection[];
}

export interface SettingsSnapshotSection {
  readonly title: string;
  readonly description?: string;
  readonly advanced?: boolean;
  readonly fields: readonly SnapshotField[];
}

/** A field as plain JSON — no functions; getters already resolved. */
export type SnapshotField =
  | ({ readonly key: string; readonly type: "boolean"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[] } & Validated)
  | ({ readonly key: string; readonly type: "enum"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly options: readonly { readonly value: string; readonly label: string; readonly description?: string }[]; readonly plainOptions?: boolean; readonly allowCustom?: boolean; readonly hint?: string; readonly scope?: "global"; readonly clearable?: boolean } & Validated)
  | ({ readonly key: string; readonly type: "string" | "secret"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly emptyLabel?: string; readonly hint?: string } & Validated)
  | ({ readonly key: string; readonly type: "number"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly min?: number; readonly max?: number; readonly unit?: string; readonly zeroLabel?: string; readonly hint?: string } & Validated)
  | ({ readonly key: string; readonly type: "model"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly provider?: string; readonly capability?: string; readonly emptyLabel?: string; readonly presets?: readonly string[]; readonly presetsByProvider?: Readonly<Record<string, readonly string[]>>; readonly emptyOption?: string; readonly providerKey?: string; readonly filtered?: boolean } & Validated)
  | ({ readonly key: string; readonly type: "multiselect"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly options: readonly { readonly value: string; readonly label: string; readonly description?: string }[]; readonly plainOptions?: boolean; readonly emptyLabel?: string } & Validated)
  | ({ readonly key: string; readonly type: "order"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly items: readonly { readonly value: string; readonly label: string }[] } & Validated)
  | ({ readonly key: string; readonly type: "page"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly sections: readonly SettingsSnapshotSection[] } & Validated)
  | ({ readonly key: string; readonly type: "action"; readonly label: string; readonly description?: string; readonly scopes?: readonly string[]; readonly command: string } & Validated);

/** The raw-input validation gate stays in pi; the flag says input beyond the type checks is pi-validated. */
interface Validated {
  readonly validated?: boolean;
}

export interface SettingsSnapshot {
  readonly version: 1;
  readonly writtenAt: string;
  /** Best-effort: the @pi-unipi/core package version, when resolvable. */
  readonly unipiVersion?: string;
  readonly namespaces: readonly SettingsSnapshotNamespace[];
}

/** The core package's version, read once (best-effort — a bundled install may not carry package.json). */
function coreVersion(): string | undefined {
  try {
    const pkg = new URL("../../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(fileURLToPath(pkg), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Serialise one field; `undefined` = skip it (a getter threw / unknown shape). */
function snapshotField(field: SettingsField): SnapshotField | undefined {
  const base = {
    key: field.key,
    label: field.label,
    ...(field.description !== undefined ? { description: field.description } : {}),
    ...(field.scopes !== undefined ? { scopes: [...field.scopes] } : {}),
    // validate stays in pi; the flag keeps the fact visible in the catalog.
    validated: "validate" in field && typeof field.validate === "function",
  };
  try {
    switch (field.type) {
      case "boolean":
        return { ...base, type: "boolean" };
      case "enum":
        return {
          ...base,
          type: "enum",
          options: field.options.map(enumOption),
          ...(field.plainOptions !== undefined ? { plainOptions: field.plainOptions } : {}),
          ...(field.allowCustom !== undefined ? { allowCustom: field.allowCustom } : {}),
          ...(field.hint !== undefined ? { hint: field.hint } : {}),
          ...(field.scope !== undefined ? { scope: field.scope } : {}),
          ...(field.clearable !== undefined ? { clearable: field.clearable } : {}),
        };
      case "string":
      case "secret":
        return {
          ...base,
          type: field.type,
          ...(field.emptyLabel !== undefined ? { emptyLabel: field.emptyLabel } : {}),
          ...(field.hint !== undefined ? { hint: field.hint } : {}),
        };
      case "number":
        return {
          ...base,
          type: "number",
          ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.unit !== undefined ? { unit: field.unit } : {}),
          ...(field.zeroLabel !== undefined ? { zeroLabel: field.zeroLabel } : {}),
          ...(field.hint !== undefined ? { hint: field.hint } : {}),
        };
      case "model":
        return {
          ...base,
          type: "model",
          ...(field.provider !== undefined ? { provider: field.provider } : {}),
          ...(field.capability !== undefined ? { capability: field.capability } : {}),
          ...(field.emptyLabel !== undefined ? { emptyLabel: field.emptyLabel } : {}),
          ...(field.presets !== undefined ? { presets: [...field.presets] } : {}),
          ...(field.presetsByProvider !== undefined
            ? { presetsByProvider: Object.fromEntries(Object.entries(field.presetsByProvider).map(([k, v]) => [k, [...v]])) }
            : {}),
          ...(field.emptyOption !== undefined ? { emptyOption: field.emptyOption } : {}),
          ...(field.providerKey !== undefined ? { providerKey: field.providerKey } : {}),
          // The filter is a function; only the fact that the catalog is filtered survives.
          ...(field.filter !== undefined ? { filtered: true } : {}),
        };
      case "multiselect":
        return {
          ...base,
          type: "multiselect",
          options: field.options.map(enumOption),
          ...(field.plainOptions !== undefined ? { plainOptions: field.plainOptions } : {}),
          ...(field.emptyLabel !== undefined ? { emptyLabel: field.emptyLabel } : {}),
        };
      case "order":
        // Resolve the universe now: the host/app must not need the module.
        return { ...base, type: "order", items: field.items().map((i) => ({ value: i.value, label: i.label })) };
      case "page":
        // Resolve the sections getter now; nested pages recurse, summary stays pi-side.
        return { ...base, type: "page", sections: snapshotSections(typeof field.sections === "function" ? field.sections() : field.sections) };
      case "action":
        return { ...base, type: "action", command: field.command };
      default:
        return undefined;
    }
  } catch {
    // A throwing getter (order items, page sections) skips just this field.
    return undefined;
  }
}

function snapshotSection(section: SettingsSection): SettingsSnapshotSection | undefined {
  try {
    const fields: SnapshotField[] = [];
    for (const field of section.fields) {
      const snap = snapshotField(field);
      if (snap) fields.push(snap);
    }
    return {
      title: section.title,
      ...(section.description !== undefined ? { description: section.description } : {}),
      ...(section.advanced !== undefined ? { advanced: section.advanced } : {}),
      fields,
    };
  } catch {
    return undefined;
  }
}

function snapshotSections(sections: readonly SettingsSection[]): SettingsSnapshotSection[] {
  const out: SettingsSnapshotSection[] = [];
  for (const section of sections) {
    const snap = snapshotSection(section);
    if (snap) out.push(snap);
  }
  return out;
}

function snapshotNamespace(definition: SettingsDefinition): SettingsSnapshotNamespace {
  return {
    namespace: definition.namespace,
    label: definition.label,
    defaults: definition.defaults,
    projectOverrides: definition.projectOverrides !== false,
    mirrored: typeof definition.onSet === "function",
    sections: snapshotSections(definition.schema ?? []),
  };
}

/** Flatten the live settings registry into plain, getter-free JSON. */
export function buildSettingsSnapshot(): SettingsSnapshot {
  const version = coreVersion();
  return {
    version: 1,
    writtenAt: new Date().toISOString(),
    ...(version !== undefined ? { unipiVersion: version } : {}),
    namespaces: listSettingsDefinitions().map(snapshotNamespace),
  };
}

const SNAPSHOT_FILE = "settings-schema.json";

/**
 * Publish the snapshot to `~/.unipi/config/settings-schema.json` — atomically
 * (tmp + rename), and only when the content other than `writtenAt` changed
 * (a clock-only diff must not dirty the file on every session start). Never
 * throws: publishing is best-effort by design.
 */
export function writeSettingsSnapshot(): void {
  try {
    const snapshot = buildSettingsSnapshot();
    const file = joinPath(unipiConfigRoot(), SNAPSHOT_FILE);
    mkdirSync(dirname(file), { recursive: true });
    const previous = readPrevious(file);
    if (previous && sameExceptWrittenAt(previous, snapshot)) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // Best-effort: no snapshot, no crash.
  }
}

function joinPath(root: string, file: string): string {
  return root.endsWith("/") ? `${root}${file}` : `${root}/${file}`;
}

function readPrevious(file: string): SettingsSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SettingsSnapshot;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Everything except `writtenAt` must be equal to skip the rewrite. */
function sameExceptWrittenAt(a: SettingsSnapshot, b: SettingsSnapshot): boolean {
  const { writtenAt: _a, ...restA } = a as SettingsSnapshot & { writtenAt?: string };
  const { writtenAt: _b, ...restB } = b as SettingsSnapshot & { writtenAt?: string };
  return JSON.stringify(restA) === JSON.stringify(restB);
}
