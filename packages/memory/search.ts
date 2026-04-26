/**
 * @unipi/memory — Hybrid search algorithm
 *
 * Combines vector similarity search with fuzzy text matching
 * for best recall across semantic and exact matches.
 */

import type { MemoryStorage, MemoryRecord, SearchResult } from "./storage.js";

/**
 * Perform hybrid search combining vector + fuzzy.
 */
export function hybridSearch(
  storage: MemoryStorage,
  query: string,
  limit = 10,
  embedding?: Float32Array | null
): SearchResult[] {
  // Delegate to storage's search method which already implements hybrid
  return storage.search(query, limit, embedding);
}

/**
 * Calculate fuzzy match score between text and query.
 * Returns 0-1 score (1 = perfect match).
 */
export function fuzzyMatch(text: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Exact match
  if (lowerText === lowerQuery) return 1.0;

  // Starts with
  if (lowerText.startsWith(lowerQuery)) return 0.9;

  // Contains
  if (lowerText.includes(lowerQuery)) return 0.7;

  // Word boundary match
  const words = lowerQuery.split(/\s+/);
  let matchedWords = 0;
  for (const word of words) {
    if (lowerText.includes(word)) {
      matchedWords++;
    }
  }
  if (matchedWords > 0) {
    return 0.3 + (matchedWords / words.length) * 0.4;
  }

  // Subsequence match
  let textIdx = 0;
  let queryIdx = 0;
  let subsequenceMatches = 0;

  while (textIdx < lowerText.length && queryIdx < lowerQuery.length) {
    if (lowerText[textIdx] === lowerQuery[queryIdx]) {
      subsequenceMatches++;
      queryIdx++;
    }
    textIdx++;
  }

  if (queryIdx === lowerQuery.length) {
    // All query chars found in order
    return 0.2 + (subsequenceMatches / lowerQuery.length) * 0.2;
  }

  return 0;
}

/**
 * Extract a snippet around the query match.
 */
export function extractSnippet(
  content: string,
  query: string,
  chars = 150
): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Find best match position
  let bestIdx = -1;
  let bestScore = 0;

  const words = lowerQuery.split(/\s+/);
  for (const word of words) {
    const idx = lowerContent.indexOf(word);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
      bestScore = 0.8;
    }
  }

  if (bestIdx === -1) {
    // No match, return beginning
    return content.slice(0, chars) + (content.length > chars ? "..." : "");
  }

  const start = Math.max(0, bestIdx - chars / 3);
  const end = Math.min(content.length, bestIdx + chars * 2 / 3);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet;
}

/**
 * Merge and deduplicate search results from multiple sources.
 */
export function mergeResults(
  ...resultSets: SearchResult[][]
): SearchResult[] {
  const merged = new Map<string, SearchResult>();

  for (const results of resultSets) {
    for (const result of results) {
      const existing = merged.get(result.record.id);
      if (existing) {
        // Boost score if found in multiple sources
        existing.score = Math.min(existing.score + result.score * 0.2, 1);
      } else {
        merged.set(result.record.id, { ...result });
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score);
}
