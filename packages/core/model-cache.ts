/**
 * @pi-unipi/core — Model Cache
 *
 * File-based model list cache at ~/.unipi/config/models-cache.json — the one
 * catalog every unipi surface reads (settings hub pickers, kanboard, image
 * pickers) without needing ctx.modelRegistry. Written by utility on every
 * session start from pi's live registry (models with credentials), plus the
 * image-generation models pi-ai publishes separately.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Resolve the model cache directory at call time (respects HOME changes). */
function cacheDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "~",
    ".unipi/config",
  );
}

/** Resolve the model cache file path at call time. */
export function modelCachePath(): string {
  return path.join(cacheDir(), "models-cache.json");
}

export type Modality = "text" | "image";

/** A single cached model entry */
export interface CachedModel {
  /** Model provider (e.g. "openai", "anthropic") */
  provider: string;
  /** Model ID (e.g. "gpt-4o", "claude-sonnet-4-6") */
  id: string;
  /** Optional display name */
  name?: string;
  /** Input modalities. Absent in pre-v3 caches → treat as ["text"]. */
  input?: Modality[];
  /** Output modalities. Chat models → ["text"]; image generators include "image". */
  output?: Modality[];
  /** "chat" = pi chat registry, "images" = pi-ai images collection / generator. */
  kind?: "chat" | "images";
  contextWindow?: number;
  reasoning?: boolean;
}

/** The full model cache structure */
export interface ModelCache {
  /** ISO timestamp of last cache write */
  updatedAt: string;
  /** List of cached models */
  models: CachedModel[];
}

/** `provider/id` reference for a cached model. */
export function modelRef(model: Pick<CachedModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function modelInputs(model: CachedModel): Modality[] {
  return model.input?.length ? model.input : ["text"];
}

export function modelOutputs(model: CachedModel): Modality[] {
  return model.output?.length ? model.output : ["text"];
}

/**
 * Filter by modality. `input` lists what the model must accept (all of them),
 * `output` what it must produce (any of them).
 */
export function filterModels(
  models: readonly CachedModel[],
  want: { input?: Modality[]; output?: Modality[] },
): CachedModel[] {
  return models.filter((m) => {
    const inputs = modelInputs(m);
    const outputs = modelOutputs(m);
    if (want.input && !want.input.every((i) => inputs.includes(i))) return false;
    if (want.output && !want.output.some((o) => outputs.includes(o))) return false;
    return true;
  });
}

/** Map pi registry models (chat) to cache entries. Tolerates partial shapes. */
export function chatModelsToCache(models: readonly unknown[]): CachedModel[] {
  const out: CachedModel[] = [];
  for (const raw of models) {
    const m = raw as { provider?: unknown; id?: unknown; name?: unknown; input?: unknown; contextWindow?: unknown; reasoning?: unknown };
    if (typeof m?.provider !== "string" || typeof m?.id !== "string") continue;
    const input = Array.isArray(m.input) ? (m.input.filter((x) => x === "text" || x === "image") as Modality[]) : ["text" as const];
    out.push({
      provider: m.provider,
      id: m.id,
      ...(typeof m.name === "string" ? { name: m.name } : {}),
      input: input.length ? input : ["text"],
      output: ["text"],
      kind: "chat",
      ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
      ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
    });
  }
  return out;
}

/**
 * Read cached model list from disk.
 * Returns empty array if no cache file exists or it's malformed.
 */
export function readModelCache(): CachedModel[] {
  try {
    const file = modelCachePath();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/**
 * Write model list to cache file.
 * Creates directory if needed. Best effort — silently ignores errors.
 * Entries are de-duplicated by `provider/id` (first wins) and sorted, so the
 * file is stable across sessions with the same catalog.
 */
export function writeModelCache(models: CachedModel[]): void {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const seen = new Set<string>();
    const unique = models.filter((m) => {
      const key = modelRef(m);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => modelRef(a).localeCompare(modelRef(b)));
    const cache: ModelCache = {
      updatedAt: new Date().toISOString(),
      models: unique,
    };
    const tmp = `${modelCachePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, modelCachePath());
  } catch {
    // Best effort — cache is optional
  }
}
