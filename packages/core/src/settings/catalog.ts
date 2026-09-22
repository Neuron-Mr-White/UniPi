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

let cache: string[] | undefined;

/** Load and cache the full "provider/model" id list. Empty on any failure. */
export function loadModelCatalog(path: string = defaultModelCatalogPath()): string[] {
  if (cache && path === defaultModelCatalogPath()) return cache;
  const ids = parseModelCatalog(() => readFileSync(path, "utf8"));
  if (path === defaultModelCatalogPath()) cache = ids;
  return ids;
}

/** Pure parser — testable without the filesystem. */
export function parseModelCatalog(read: () => string): string[] {
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
    const ids: string[] = [];
    for (const [provider, def] of Object.entries(providers as Record<string, unknown>)) {
      if (typeof def !== "object" || def === null) continue;
      const models = (def as { models?: unknown }).models;
      if (!Array.isArray(models)) continue;
      for (const model of models) {
        if (typeof model === "object" && model !== null) {
          const id = (model as { id?: unknown }).id;
          if (typeof id === "string" && id.length > 0) ids.push(`${provider}/${id}`);
        } else if (typeof model === "string") {
          ids.push(`${provider}/${model}`);
        }
      }
    }
    return ids;
  } catch {
    return [];
  }
}

/** Test hook. */
export function resetModelCatalogCache(): void {
  cache = undefined;
}
