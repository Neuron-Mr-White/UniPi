/**
 * Model catalog for `model`-type settings fields — the searchable picker's data.
 *
 * Primary source: the unipi model cache (~/.unipi/config/models-cache.json),
 * written by utility from pi's live registry every session — it covers
 * built-in providers with credentials and the image-generation collection,
 * with input/output modalities. Pi's models.json (custom providers, shape
 *   { providers: { <provider>: { models: [{ id, ... }] } } })
 * fills in anything the cache has not seen yet (first run, no session yet).
 *
 * The loader is sync + cached + never throws (empty catalog on any error), and
 * the path is injectable so tests feed a fixture instead of the real registry.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readModelCache, modelInputs, modelOutputs, modelRef } from "../../model-cache.js";

export function defaultModelCatalogPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

/** A catalog model with the metadata capability filtering needs. */
export interface ModelCatalogEntry {
  readonly id: string;
  /** Declared input modalities, e.g. ["text"] or ["text", "image"]. */
  readonly input: string[];
  /** Declared output modalities; absent → ["text"]. */
  readonly output?: string[];
}

export type ModelCapability = "text" | "image-input" | "image-output" | "image-edit";

/** Capability filter shared by every model picker. */
export function matchesCapability(entry: ModelCatalogEntry, capability: ModelCapability): boolean {
  // No declared input = unknown → hidden from capability pickers (custom… still
  // accepts any id). Output defaults to text: chat catalogs rarely declare it.
  const input = entry.input;
  const output = entry.output?.length ? entry.output : ["text"];
  switch (capability) {
    case "text": return input.includes("text") && output.includes("text");
    case "image-input": return input.includes("image") && output.includes("text");
    case "image-output": return output.includes("image");
    case "image-edit": return input.includes("image") && output.includes("image");
  }
}

/** Load the full "provider/model" id list. Empty on any failure. */
export function loadModelCatalog(path: string = defaultModelCatalogPath()): string[] {
  return loadModelCatalogEntries(path).map((e) => e.id);
}

/** Load catalog entries (ids + modalities). Read per call (picker open), so a
 *  cache rewritten mid-session is seen. Empty on any failure. */
export function loadModelCatalogEntries(path: string = defaultModelCatalogPath()): ModelCatalogEntry[] {
  const isDefault = path === defaultModelCatalogPath();
  const fromFile = parseModelCatalogEntries(() => readFileSync(path, "utf8"));
  if (!isDefault) return fromFile;
  const cached: ModelCatalogEntry[] = readModelCache().map((m) => ({
    id: modelRef(m),
    input: modelInputs(m),
    output: modelOutputs(m),
  }));
  const seen = new Set(cached.map((e) => e.id));
  return [...cached, ...fromFile.filter((e) => !seen.has(e.id))];
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

/** Test hook (the catalog is no longer cached in memory; kept for callers). */
export function resetModelCatalogCache(): void {}

/** Pure id-only parser (back-compat shim over parseModelCatalogEntries). */
export function parseModelCatalog(read: () => string): string[] {
  return parseModelCatalogEntries(read).map((e) => e.id);
}
