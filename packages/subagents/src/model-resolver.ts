/**
 * @pi-unipi/subagents — Model resolver
 *
 * Resolves model strings like "haiku", "sonnet", "anthropic/claude-sonnet-4-6"
 * to actual Model instances using the registry.
 */

import type { Model } from "@mariozechner/pi-ai";

export interface ModelRegistry {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAll(): Model<any>[];
  getAvailable?(): Model<any>[];
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first, then fuzzy match.
 * Returns Model on success, error string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): Model<any> | string {
  const all = (registry.getAvailable?.() ?? registry.getAll()) as Array<{
    id: string;
    name?: string;
    provider: string;
  }>;
  const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId"
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match
  const query = input.toLowerCase();
  let bestMatch: (typeof all)[number] | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = (m.name ?? m.id).toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100;
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30;
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match — return error with available models
  const modelList = all
    .map((m) => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
