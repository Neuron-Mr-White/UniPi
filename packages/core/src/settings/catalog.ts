/**
 * Model catalog for `model`-type settings fields — the searchable picker's data.
 *
 * Source: pi's own model registry (~/.pi/agent/models.json), the same catalog
 * `pi --list-models` renders. The omniroute bridge keeps it current. Shape:
 *   { providers: { <provider>: { models: [{ id, ... }] } } }
 * → flattened ["provider/model-id", …] ids.
 *
 * The loader is sync + cached + never throws (empty catalog on any error), and
 * the path is injectable so tests feed a fixture instead of the real registry.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultModelCatalogPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

/** A catalog model with the metadata capability filtering needs. */
export interface ModelCatalogEntry {
  readonly id: string;
  /** Declared input modalities, e.g. ["text"] or ["text", "image"]. */
  readonly input: string[];
}

let entryCache: ModelCatalogEntry[] | undefined;

/** Load and cache the full "provider/model" id list. Empty on any failure. */
export function loadModelCatalog(path: string = defaultModelCatalogPath()): string[] {
  return loadModelCatalogEntries(path).map((e) => e.id);
}

/** Load and cache catalog entries (ids + metadata). Empty on any failure. */
export function loadModelCatalogEntries(path: string = defaultModelCatalogPath()): ModelCatalogEntry[] {
  if (entryCache && path === defaultModelCatalogPath()) return entryCache;
  const entries = parseModelCatalogEntries(() => readFileSync(path, "utf8"));
  if (path === defaultModelCatalogPath()) entryCache = entries;
  return entries;
}

/** Pure parser — testable without the filesystem. */
export function parseModelCatalogEntries(read: () => string): ModelCatalogEntry[] {
  let raw: string;
  try {
    raw = read();
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return [];
    const providers = (parsed as { providers?: unknown }).providers;
    if (typeof providers !== "object" || providers === null) return [];
    const entries: ModelCatalogEntry[] = [];
    for (const [provider, def] of Object.entries(providers as Record<string, unknown>)) {
      if (typeof def !== "object" || def === null) continue;
      const models = (def as { models?: unknown }).models;
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (typeof model === "object" && model !== null) {
          const id = (model as { id?: unknown }).id;
          if (typeof id !== "string" || id.length === 0) continue;
          const input = (model as { input?: unknown }).input;
          entries.push({
            id: `${provider}/${id}`,
            input: Array.isArray(input) ? input.filter((m): m is string => typeof m === "string") : [],
          });
        } else if (typeof model === "string") {
          entries.push({ id: `${provider}/${model}`, input: [] });
        }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Test hook. */
export function resetModelCatalogCache(): void {
  entryCache = undefined;
}

/** Pure id-only parser (back-compat shim over parseModelCatalogEntries). */
export function parseModelCatalog(read: () => string): string[] {
  return parseModelCatalogEntries(read).map((e) => e.id);
}
