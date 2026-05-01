/**
 * Tests for the 4-tier autocomplete command sorting model.
 *
 * Exercises crossItemPriority() and sortTaggedItems() from sorting.ts.
 * These are pure functions extracted from the provider closure for testability.
 */

import { describe, it, expect } from "vitest";
import {
  crossItemPriority,
  sortTaggedItems,
  type TaggedItem,
} from "../sorting.js";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Shorthand to create an AutocompleteItem. */
function item(value: string, label?: string): AutocompleteItem {
  return { value, label: label ?? value, description: "" };
}

/** Shorthand to create a TaggedItem. */
function tagged(value: string, isUnipi: boolean, label?: string): TaggedItem {
  return { item: item(value, label), isUnipi };
}

/** Extract just the values from a sorted TaggedItem[] for easy assertions. */
function values(sorted: TaggedItem[]): string[] {
  return sorted.map((t) => t.item.value);
}

// ═══════════════════════════════════════════════════════════════════════
//  crossItemPriority — tier assignment
// ═══════════════════════════════════════════════════════════════════════

describe("crossItemPriority", () => {
  // ── Tier 0: exact full-value match ──────────────────────────────────

  it("assigns tier 0 for exact base command match", () => {
    // query "new" matches item value "new" exactly
    expect(crossItemPriority(item("new"), false, "new")).toBe(0);
  });

  it("assigns tier 0 for exact unipi full-value match", () => {
    // query "unipi:brainstorm" matches item value "unipi:brainstorm"
    expect(crossItemPriority(item("unipi:brainstorm"), true, "unipi:brainstorm")).toBe(0);
  });

  it("does NOT assign tier 0 for short-name-only match on unipi item", () => {
    // query "brainstorm" is not the full value "unipi:brainstorm"
    expect(crossItemPriority(item("unipi:brainstorm"), true, "brainstorm")).not.toBe(0);
  });

  // ── Tier 1: unipi short-name exact match ────────────────────────────

  it("assigns tier 1 when unipi short name matches query exactly", () => {
    expect(crossItemPriority(item("unipi:brainstorm"), true, "brainstorm")).toBe(1);
  });

  it("does NOT assign tier 1 for non-unipi items", () => {
    // "new" is not a unipi item, so short === full === "new", which is tier 0 (exact)
    expect(crossItemPriority(item("new"), false, "new")).toBe(0);
  });

  it("does NOT assign tier 1 when unipi short name doesn't match", () => {
    expect(crossItemPriority(item("unipi:brainstorm"), true, "brain")).not.toBeLessThanOrEqual(1);
  });

  // ── Tier 2: prefix match ────────────────────────────────────────────

  it("assigns tier 2 for base prefix match", () => {
    expect(crossItemPriority(item("work"), false, "wor")).toBe(2);
  });

  it("assigns tier 2 for unipi short-name prefix match", () => {
    // short = "work", query = "wor" → startsWith → tier 2
    expect(crossItemPriority(item("unipi:work"), true, "wor")).toBe(2);
  });

  it("assigns tier 2 when full value has prefix (unipi: prefix)", () => {
    // full = "unipi:compact", query = "unipi:co" → startsWith → tier 2
    expect(crossItemPriority(item("unipi:compact"), true, "unipi:co")).toBe(2);
  });

  // ── Tier 3: fuzzy fallback ──────────────────────────────────────────

  it("assigns tier 3 for fuzzy-only match", () => {
    // "review-work" doesn't start with "wor" but contains characters
    expect(crossItemPriority(item("unipi:review-work"), true, "wor")).toBe(3);
  });

  it("assigns tier 3 for character subsequence match", () => {
    // "fix" is a subsequence of... no wait, let's use "fx" vs "fix"
    // "fix" contains f, i, x. query "fx" → f...x → subsequence → tier 3
    expect(crossItemPriority(item("fix"), false, "fx")).toBe(3);
  });

  it("assigns tier 3 for non-matching query (all items get tier 3)", () => {
    expect(crossItemPriority(item("brainstorm"), false, "xyz")).toBe(3);
  });

  // ── Case insensitivity ──────────────────────────────────────────────

  it("matches case-insensitively (tier 0)", () => {
    expect(crossItemPriority(item("new"), false, "New")).toBe(0);
    expect(crossItemPriority(item("New"), false, "new")).toBe(0);
  });

  it("matches case-insensitively (tier 2)", () => {
    expect(crossItemPriority(item("Compact"), false, "co")).toBe(2);
  });

  it("matches case-insensitively (tier 1)", () => {
    expect(crossItemPriority(item("unipi:Brainstorm"), true, "brainstorm")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  sortTaggedItems — cross-group merge sort
// ═══════════════════════════════════════════════════════════════════════

describe("sortTaggedItems", () => {
  // ── Test 1: Exact base command before fuzzy unipi ───────────────────

  it("ranks exact base command (tier 0) before fuzzy unipi (tier 3)", () => {
    const items = [
      tagged("unipi:review-work", true), // tier 3 (r→e→w fuzzy)
      tagged("new", false),              // tier 0 (exact)
    ];

    const sorted = sortTaggedItems(items, "new");
    expect(values(sorted)).toEqual(["new", "unipi:review-work"]);
  });

  // ── Test 2: Unipi short-name exact (tier 1) ────────────────────────

  it("ranks unipi short-name exact (tier 1) above prefix and fuzzy", () => {
    const items = [
      tagged("unipi:brainstorm", true), // tier 1
      tagged("unipi:plan", true),       // tier 3 (no b-r-a-i-n)
    ];

    const sorted = sortTaggedItems(items, "brainstorm");
    expect(sorted[0].item.value).toBe("unipi:brainstorm");
    expect(crossItemPriority(items[0].item, true, "brainstorm")).toBe(1);
  });

  // ── Test 3: Full unipi exact (tier 0) ──────────────────────────────

  it("ranks full unipi: value exact match as tier 0", () => {
    const items = [
      tagged("unipi:brainstorm", true),
      tagged("brainstorm", false), // also tier 0 exact on value
    ];

    const sorted = sortTaggedItems(items, "unipi:brainstorm");
    // Both could be tier 0 or fuzzy. unipi:brainstorm is tier 0 (exact full).
    // "brainstorm" as base: full "brainstorm" !== "unipi:brainstorm" → not tier 0
    // full.startsWith query? "brainstorm".startsWith("unipi:brainstorm") → no
    // So "brainstorm" gets tier 3
    expect(sorted[0].item.value).toBe("unipi:brainstorm");
  });

  // ── Test 4: Prefix match ordering (non-unipi before unipi) ─────────

  it("within same tier, sorts non-unipi before unipi", () => {
    const items = [
      tagged("unipi:work", true),  // tier 2 (prefix "wor" → "work")
      tagged("work", false),       // tier 2 (prefix "wor" → "work")
    ];

    const sorted = sortTaggedItems(items, "wor");
    expect(values(sorted)).toEqual(["work", "unipi:work"]);
  });

  // ── Test 5: Fuzzy sorted by similarity (shorter name first) ────────

  it("within tier 3 fuzzy, shorter names sort first", () => {
    const items = [
      tagged("unipi:review-work", true), // longer
      tagged("fix", false),              // shorter
      tagged("unipi:fix", true),         // medium
    ];

    const sorted = sortTaggedItems(items, "fx");
    // All tier 3 fuzzy. Sorted by: non-unipi first, then by length.
    // "fix" (len 3, non-unipi) → "unipi:fix" (len 9, unipi) → "unipi:review-work" (len 17, unipi)
    expect(values(sorted)).toEqual(["fix", "unipi:fix", "unipi:review-work"]);
  });

  // ── Test 6: Mixed tiers ────────────────────────────────────────────

  it("sorts across mixed tiers: exact → prefix → fuzzy", () => {
    const items = [
      tagged("unipi:compact", true),    // tier 2 (prefix "co")
      tagged("compact-xyz", false),     // tier 2 (prefix "co")
      tagged("co", false),              // tier 0 (exact "co")
      tagged("unipi:consultant", true), // tier 2 (prefix "co")
      tagged("config", false),          // tier 2 (prefix "co")
      tagged("unipi:chore-create", true), // tier 3 (fuzzy c→o)
    ];

    const sorted = sortTaggedItems(items, "co");
    // Tier 0: co
    // Tier 2: compact-xyz, config (non-unipi) then unipi:compact, unipi:consultant (unipi)
    // Tier 3: unipi:chore-create
    const result = values(sorted);
    expect(result[0]).toBe("co");
    // Tier 2 non-unipi
    expect(result.slice(1, 3)).toEqual(expect.arrayContaining(["compact-xyz", "config"]));
    // Tier 2 unipi
    expect(result.slice(3, 5)).toEqual(expect.arrayContaining(["unipi:compact", "unipi:consultant"]));
    // Tier 3
    expect(result[5]).toBe("unipi:chore-create");
  });

  // ── Test 7: No base command match, only unipi ──────────────────────

  it("handles unipi-only matches (tier 1 short-name exact)", () => {
    const items = [
      tagged("unipi:ralph", true),     // tier 1 (short "ralph" === "ralph")
      tagged("unipi:ralph-stop", true), // tier 2 (prefix "ralph")
    ];

    const sorted = sortTaggedItems(items, "ralph");
    expect(values(sorted)).toEqual(["unipi:ralph", "unipi:ralph-stop"]);
  });

  // ── Test 8: Skill commands filtered (simulated: skill: items present) ─

  it("sortItems does not filter skill commands — that's the provider's job", () => {
    // The sorting function itself is pure — it just sorts whatever it receives.
    // Skill filtering happens at the provider level. Verify sorting handles them.
    // Note: "skill:animate" does NOT start with "a", so it gets tier 3 (fuzzy).
    // "unipi:auto" short name "auto" starts with "a" → tier 2 (prefix).
    const items = [
      tagged("skill:animate", false),
      tagged("skill:audit", false),
      tagged("unipi:auto", true),
    ];

    const sorted = sortTaggedItems(items, "a");
    // unipi:auto (tier 2) before skill: items (tier 3)
    // Within tier 3: non-unipi, sorted by length: audit(11) < animate(13)
    expect(values(sorted)).toEqual(["unipi:auto", "skill:audit", "skill:animate"]);
  });

  // ── Test 9: Skill query scenario ───────────────────────────────────

  it("when skill: prefix items are present, they sort by tier like any other", () => {
    // "skill:work" does NOT start with "work" → tier 3 (fuzzy)
    // "unipi:work" short name "work" starts with "work" → tier 2 (prefix)
    const items = [
      tagged("skill:work", false),       // tier 3 (fuzzy)
      tagged("unipi:work", true),        // tier 2 (prefix)
      tagged("skill:workshop", false),   // tier 3 (fuzzy)
    ];

    const sorted = sortTaggedItems(items, "work");
    // unipi:work (tier 2) before skill items (tier 3)
    // Within tier 3: non-unipi, sorted by length: skill:work(11) < skill:workshop(15)
    expect(values(sorted)).toEqual(["unipi:work", "skill:work", "skill:workshop"]);
  });

  // ── Test 10: Empty query ───────────────────────────────────────────

  it("empty query gives all items tier 0 (exact on empty string)", () => {
    // When query is "", every value matches exactly: "".startsWith("") → true
    // Actually: full === "" is false for non-empty values. But "".startsWith("") is true → tier 2
    // Wait: full === q where q = "". If value is "new", full="new" !== "" → not tier 0.
    // short.startsWith("") → true → tier 2.
    // So all items get tier 2 when query is "".
    // Within tier 2: non-unipi first, then stable.
    const items = [
      tagged("unipi:brain", true),
      tagged("new", false),
      tagged("unipi:work", true),
      tagged("fix", false),
    ];

    const sorted = sortTaggedItems(items, "");
    // All tier 2. Non-unipi first (preserving original order), then unipi.
    expect(values(sorted)).toEqual(["new", "fix", "unipi:brain", "unipi:work"]);
  });

  // ── Test 11: Case insensitive ──────────────────────────────────────

  it("matches case-insensitively across tiers", () => {
    const items = [
      tagged("unipi:Brainstorm", true),
      tagged("New", false),
    ];

    // query "/New" stripped → "new"
    const sorted = sortTaggedItems(items, "new");
    expect(sorted[0].item.value).toBe("New"); // tier 0 exact (case-insensitive)

    // query "BRAINSTORM" → unipi short-name "brainstorm" exact (case-insensitive)
    const sorted2 = sortTaggedItems(items, "BRAINSTORM");
    expect(sorted2[0].item.value).toBe("unipi:Brainstorm"); // tier 1
  });

  // ── Test 12: Stable sort ───────────────────────────────────────────

  it("preserves original order for items at same tier and same source", () => {
    const items = [
      tagged("alpha", false),     // tier 2 (prefix "a")
      tagged("unipi:a-first", true),  // tier 2
      tagged("beta", false),      // tier 2
      tagged("unipi:a-second", true), // tier 2
      tagged("gamma", false),     // tier 2
    ];

    const sorted = sortTaggedItems(items, "a");
    const result = values(sorted);

    // Non-unipi items preserve their original relative order: alpha, beta, gamma
    const nonUnipi = result.filter((v) => !v.startsWith("unipi:"));
    expect(nonUnipi).toEqual(["alpha", "beta", "gamma"]);

    // Unipi items preserve their original relative order: a-first, a-second
    const unipiItems = result.filter((v) => v.startsWith("unipi:"));
    expect(unipiItems).toEqual(["unipi:a-first", "unipi:a-second"]);
  });

  // ── Test 13: btw:new scenario ──────────────────────────────────────

  it("btw:new gets tier 3 fuzzy for query 'new' (not prefix match)", () => {
    // "btw:new" does NOT start with "new" → not tier 2
    // "btw:new" !== "new" → not tier 0
    // fuzzy match: b...t...w...:...n...e...w → "new" is subsequence → tier 3
    const items = [
      tagged("btw:new", false),     // tier 3
      tagged("new", false),         // tier 0
      tagged("unipi:new-thing", true), // tier 2 (prefix "new")
    ];

    const sorted = sortTaggedItems(items, "new");
    expect(values(sorted)).toEqual(["new", "unipi:new-thing", "btw:new"]);
  });

  it("verifies btw:new is tier 3 for query 'new'", () => {
    expect(crossItemPriority(item("btw:new"), false, "new")).toBe(3);
  });

  it("verifies 'new' is tier 0 for query 'new'", () => {
    expect(crossItemPriority(item("new"), false, "new")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Additional edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  it("handles single item", () => {
    const items = [tagged("new", false)];
    const sorted = sortTaggedItems(items, "new");
    expect(values(sorted)).toEqual(["new"]);
  });

  it("handles empty input array", () => {
    const sorted = sortTaggedItems([], "new");
    expect(sorted).toEqual([]);
  });

  it("does not mutate the original array", () => {
    const original = [tagged("b", false), tagged("a", false)];
    const copy = [...original];
    sortTaggedItems(original, "a");
    expect(original).toEqual(copy);
  });

  it("sorts multiple tier 0 exact matches (non-unipi before unipi)", () => {
    const items = [
      tagged("unipi:abc", true), // tier 0 (full value "unipi:abc" === query)
      tagged("unipi:abc", false), // tier 0 (but isUnipi=false, value doesn't start with "unipi:")
    ];

    // Both have value "unipi:abc", but one is tagged isUnipi=true
    // Wait: the non-unipi one has value "unipi:abc" — that's unusual but possible
    // crossItemPriority: full="unipi:abc" === "unipi:abc" → tier 0 for both
    // Same tier → non-unipi first
    const sorted = sortTaggedItems(items, "unipi:abc");
    expect(sorted[0].isUnipi).toBe(false);
    expect(sorted[1].isUnipi).toBe(true);
  });

  it("tier 3 sorts by length, non-unipi first within same length", () => {
    const items = [
      tagged("unipi:ab", true),   // len 9, tier 3
      tagged("cd", false),        // len 2, tier 3
      tagged("ef", false),        // len 2, tier 3
      tagged("unipi:gh", true),   // len 9, tier 3
    ];

    const sorted = sortTaggedItems(items, "z");
    // All tier 3. Non-unipi first (by length within non-unipi): cd(2), ef(2)
    // Then unipi (by length): unipi:ab(9), unipi:gh(9)
    const result = values(sorted);
    expect(result.slice(0, 2)).toEqual(["cd", "ef"]);
    expect(result.slice(2, 4)).toEqual(["unipi:ab", "unipi:gh"]);
  });

  it("handles query matching full unipi prefix + partial short name", () => {
    // query "unipi:bra" → full "unipi:brainstorm".startsWith("unipi:bra") → tier 2
    expect(crossItemPriority(item("unipi:brainstorm"), true, "unipi:bra")).toBe(2);
  });

  it("unipi item with tier 1 beats base item with tier 2", () => {
    const items = [
      tagged("work", false),           // tier 2 (prefix "brain"... no)
      tagged("unipi:brainstorm", true), // tier 1 (short exact)
    ];

    // query "brainstorm": 
    // "work" → full "work" !== "brainstorm", !startsWith → tier 3
    // "unipi:brainstorm" → short "brainstorm" === "brainstorm" → tier 1
    const sorted = sortTaggedItems(items, "brainstorm");
    expect(values(sorted)).toEqual(["unipi:brainstorm", "work"]);
  });
});
