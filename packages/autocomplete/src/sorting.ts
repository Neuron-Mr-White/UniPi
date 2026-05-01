/**
 * @pi-unipi/command-enchantment — Sorting Logic
 *
 * Extracted cross-item priority and merge-sort for testability.
 */

import type { AutocompleteItem } from "@mariozechner/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────

/** Tagged item carrying its source group for sorting. */
export interface TaggedItem {
  item: AutocompleteItem;
  isUnipi: boolean;
}

// ─── 4-tier priority ─────────────────────────────────────────────────

/**
 * Compute the match-quality tier for an autocomplete item.
 *
 *   Tier 0 — Base command exact match: full `item.value` equals the query.
 *            Also catches `unipi:abc` when user typed `unipi:abc`.
 *   Tier 1 — Unipi short-name exact match: query `brainstorm` →
 *            `unipi:brainstorm` (text after `unipi:` matches exactly).
 *   Tier 2 — Prefix match: command name starts with the query.
 *   Tier 3 — Fuzzy match: character subsequence.
 */
export function crossItemPriority(
  item: AutocompleteItem,
  isUnipi: boolean,
  query: string,
): number {
  const full = item.value.toLowerCase();
  const short = isUnipi
    ? item.value.replace("unipi:", "").toLowerCase()
    : full;

  const q = query.toLowerCase();

  // Tier 0: exact full-value match
  if (full === q) return 0;
  // Tier 1: unipi short-name exact match
  if (isUnipi && short === q) return 1;
  // Tier 2: prefix match
  if (short.startsWith(q) || full.startsWith(q)) return 2;
  // Tier 3: fuzzy
  return 3;
}

// ─── Cross-group merge sort ─────────────────────────────────────────

/**
 * Sort a mixed list of system + unipi items using the 4-tier model.
 *
 * Within the same tier:
 *   - non-unipi commands sort before unipi commands
 *   - Tier 3 fuzzy: shorter name = closer match
 *   - Stable sort preserves original order for ties
 */
export function sortTaggedItems(items: TaggedItem[], query: string): TaggedItem[] {
  const copy = [...items];
  copy.sort((a, b) => {
    const priA = crossItemPriority(a.item, a.isUnipi, query);
    const priB = crossItemPriority(b.item, b.isUnipi, query);
    if (priA !== priB) return priA - priB;

    // Same tier: non-unipi first
    if (a.isUnipi !== b.isUnipi) return a.isUnipi ? 1 : -1;

    // Tier 3 (fuzzy): sort by similarity — shorter name = closer match
    if (priA === 3) {
      const lenA = a.item.value.length;
      const lenB = b.item.value.length;
      if (lenA !== lenB) return lenA - lenB;
    }

    return 0; // preserve original order (stable sort)
  });
  return copy;
}
