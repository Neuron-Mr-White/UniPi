/**
 * @pi-unipi/command-enchantment — Autocomplete Provider
 *
 * Intercepts /unipi:* autocomplete and returns enhanced items with
 * package-colored tags, sorted grouping, and descriptions.
 * Non-unipi commands pass through unchanged.
 */

import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@mariozechner/pi-tui";
import { fuzzyFilter } from "@mariozechner/pi-tui";

import {
  COMMAND_REGISTRY,
  COMMAND_DESCRIPTIONS,
  PACKAGE_COLORS,
  PACKAGE_LABELS,
  PACKAGE_ORDER,
  colorize,
} from "./constants.js";

// ─── Fuzzy matching ──────────────────────────────────────────────────

/** Simple character-subsequence fuzzy match (case-insensitive) */
function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ─── Namespace detection ─────────────────────────────────────────────

/**
 * If the query looks like a package namespace (e.g. "workflow", "memory",
 * "utility"), return that package name so its commands sort to the top.
 * Returns null when the query isn't a pure namespace search.
 */
function detectNamespaceBoost(query: string): string | null {
  if (!query) return null;
  const q = query.toLowerCase();
  // Direct match against known package names (and common aliases)
  const NAMESPACE_ALIASES: Record<string, string> = {
    // Full package names
    workflow: "workflow",
    ralph: "ralph",
    memory: "memory",
    milestone: "milestone",
    mcp: "mcp",
    utility: "utility",
    "ask-user": "ask-user",
    info: "info",
    "web-api": "web-api",
    compact: "compact",
    notify: "notify",
    // Unambiguous short aliases
    mem: "memory",
    ms: "milestone",
    goal: "milestone",
    util: "utility",
    web: "web-api",
    notification: "notify",
  };
  return NAMESPACE_ALIASES[q] ?? null;
}

// ─── Enhanced item generation ────────────────────────────────────────

/**
 * Generate enhanced autocomplete items for unipi commands,
 * sorted by package order then alphabetically within each package.
 * When the query matches a package namespace, that package floats to top.
 */
function getEnhancedUnipiItems(
  prefix: string,
  descriptionOverrides: Map<string, string> = new Map(),
): AutocompleteItem[] {
  // The base provider sets prefix = full textBeforeCursor e.g. "/uni", "/unipi:brain".
  // Two cases:
  //   Case A  "/unipi:something" — user typed past the colon; match the short name.
  //   Case B  "/something"       — user is still forming the command word; the base
  //                                 fuzzyFilter matched against the full "unipi:work"
  //                                 string, so we must do the same.
  const stripped = prefix.replace(/^\//, "").toLowerCase();
  const isPastUnipiColon = stripped.startsWith("unipi:");
  const query = isPastUnipiColon
    ? stripped.slice("unipi:".length) // e.g. "brain" from "/unipi:brain"
    : stripped;                        // e.g. "uni" from "/uni"

  const entries = Object.entries(COMMAND_REGISTRY);

  // Detect namespace query: when the query is exactly a package name/alias
  // (e.g. "workflow", "mem", "utility") short-circuit and return ALL commands
  // from that package, sorted by name, with other packages following.
  const boostedPackage = detectNamespaceBoost(query);

  let matched: [string, string][];

  if (boostedPackage) {
    // Namespace mode: show boosted package first (all its commands), then
    // remaining packages in normal order.
    // Works for both "/workflow" and "/unipi:workflow".
    matched = entries;
  } else {
    // Case A: match short name ("brain" against "brainstorm")
    // Case B: match full value ("uni" against "unipi:work") so all unipi
    //         commands surface when the user hasn't typed the full prefix.
    matched = entries.filter(([cmd]) => {
      if (isPastUnipiColon) {
        return fuzzyMatch(cmd.replace("unipi:", "").toLowerCase(), query);
      }
      return fuzzyMatch(cmd.toLowerCase(), query);
    });
  }

  // Determine match quality for ranking exact > prefix > fuzzy
  const getMatchPriority = (cmd: string): number => {
    const name = isPastUnipiColon
      ? cmd.replace("unipi:", "").toLowerCase()
      : cmd.toLowerCase();
    if (name === query) return 0;        // Exact match
    if (name.startsWith(query)) return 1; // Prefix match
    return 2;                              // Fuzzy match
  };

  // Sort: boosted package first, then exact > prefix > fuzzy,
  // then by PACKAGE_ORDER, then alphabetically.
  matched.sort((a, b) => {
    const pkgA = a[1];
    const pkgB = b[1];

    if (boostedPackage) {
      const aIsBoosted = pkgA === boostedPackage;
      const bIsBoosted = pkgB === boostedPackage;
      if (aIsBoosted && !bIsBoosted) return -1;
      if (!aIsBoosted && bIsBoosted) return 1;
    }

    // Rank by match quality: exact > prefix > fuzzy
    const priA = getMatchPriority(a[0]);
    const priB = getMatchPriority(b[0]);
    if (priA !== priB) return priA - priB;

    const orderA = PACKAGE_ORDER.indexOf(pkgA);
    const orderB = PACKAGE_ORDER.indexOf(pkgB);
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  // Map to AutocompleteItem format
  return matched.map(([cmd, pkg]) => {
    const color = PACKAGE_COLORS[pkg] ?? "";
    const label = PACKAGE_LABELS[pkg] ?? pkg;

    // Use description from base suggestions if available, else from our map
    const desc =
      descriptionOverrides.get(cmd) ??
      COMMAND_DESCRIPTIONS[cmd] ??
      "";

    const tag = colorize(color, `[${label}]`);

    return {
      value: cmd,
      label: cmd.replace("unipi:", ""),
      description: desc ? `${tag} ${desc}` : tag,
    };
  });
}

// ─── Argument re-trigger helpers ─────────────────────────────────────

/**
 * Return true when textBeforeCursor is inside the arguments of a /unipi:* command.
 * e.g. "/unipi:work " or "/unipi:work plan:foo" → true
 *      "/unipi:work" (no space) → false
 */
function isInUnipiArgPosition(textBeforeCursor: string): boolean {
  const spaceIdx = textBeforeCursor.indexOf(" ");
  if (spaceIdx === -1) return false;
  const cmdName = textBeforeCursor.slice(1, spaceIdx); // strip leading "/"
  return cmdName.startsWith("unipi:");
}

// ─── Provider factory ────────────────────────────────────────────────

/**
 * Create an enhanced autocomplete provider that wraps the base provider.
 *
 * @param current - The base (CombinedAutocompleteProvider) to delegate to
 * @param enabled - Whether enhancement is active (if false, pure delegation)
 */
export function createEnchantedProvider(
  current: AutocompleteProvider,
  enabled: boolean,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal; force?: boolean },
    ): Promise<AutocompleteSuggestions | null> {
      // When disabled, pure passthrough
      if (!enabled) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);

      // Only intercept slash commands
      if (!textBeforeCursor.startsWith("/")) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      // ── Argument position ──────────────────────────────────────────
      // When there's a space, the user is typing arguments for a command.
      // The base provider handles argument completions only when force=false
      // (it skips the slash-command path entirely when force=true, falling
      // back to file suggestions instead).  We fix that by always calling
      // base with force=false so the getArgumentCompletions path is taken.
      if (textBeforeCursor.includes(" ")) {
        if (isInUnipiArgPosition(textBeforeCursor)) {
          // Force the non-force path so argument completions are returned
          // even when the editor called us with force=true (Tab key after space).
          return current.getSuggestions(lines, cursorLine, cursorCol, {
            ...options,
            force: false,
          });
        }
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      // ── Command-name position ──────────────────────────────────────
      // Get base suggestions (includes all commands)
      const baseSuggestions = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );

      // Separate: keep non-unipi items, collect unipi descriptions
      const nonUnipiItems: AutocompleteItem[] = [];
      const descriptionOverrides = new Map<string, string>();

      if (baseSuggestions) {
        for (const item of baseSuggestions.items) {
          if (item.value.startsWith("unipi:")) {
            if (item.description) {
              descriptionOverrides.set(item.value, item.description);
            }
          } else {
            nonUnipiItems.push(item);
          }
        }
      }

      // The prefix we pass to getEnhancedUnipiItems: prefer base's prefix
      // (which is the full textBeforeCursor), fall back to textBeforeCursor.
      const effectivePrefix = baseSuggestions?.prefix ?? textBeforeCursor;

      // Generate enhanced unipi items (handles namespace queries too)
      const enhancedUnipiItems = getEnhancedUnipiItems(
        effectivePrefix,
        descriptionOverrides,
      );

      // If no unipi items match, handle skill vs system items
      if (enhancedUnipiItems.length === 0) {
        if (nonUnipiItems.length === 0) return null;

        // Check if user explicitly typed /skill: prefix
        const isSkillQuery = effectivePrefix.replace(/^\//, "").toLowerCase().startsWith("skill:");
        
        if (isSkillQuery) {
          // User wants skill commands — return them
          return { items: nonUnipiItems, prefix: effectivePrefix };
        }

        // Otherwise, filter out skill commands from suggestions
        const systemOnly = nonUnipiItems.filter(item => !item.value.startsWith("skill:"));
        return systemOnly.length > 0
          ? { items: systemOnly, prefix: effectivePrefix }
          : null;
      }

      // Separate non-unipi items into system commands and skill commands
      const systemItems: AutocompleteItem[] = [];
      const skillItems: AutocompleteItem[] = [];

      for (const item of nonUnipiItems) {
        if (item.value.startsWith("skill:")) {
          skillItems.push(item);
        } else {
          systemItems.push(item);
        }
      }

      // Check if user explicitly typed /skill: prefix
      const isExplicitSkillQuery = effectivePrefix.replace(/^\//, "").toLowerCase().startsWith("skill:");

      // Extract the query for cross-group match quality scoring
      const finalQuery = effectivePrefix.replace(/^\//, "").toLowerCase();

      /**
       * 4-tier match quality for cross-group sorting:
       *   Tier 0 — Base command exact match (full value equals query).
       *             Also catches /unipi:abc when user typed "unipi:abc".
       *   Tier 1 — Unipi short-name exact match.
       *             E.g. query "brainstorm" → unipi:brainstorm.
       *   Tier 2 — Prefix match (name starts with query).
       *   Tier 3 — Fuzzy match (character subsequence), sorted by
       *             similarity (shorter edit distance first).
       */
      const crossItemPriority = (
        item: AutocompleteItem,
        isUnipi: boolean,
      ): number => {
        const full = item.value.toLowerCase();
        const short = isUnipi
          ? item.value.replace("unipi:", "").toLowerCase()
          : full;

        // Tier 0: exact full-value match
        if (full === finalQuery) return 0;
        // Tier 1: unipi short-name exact match
        if (isUnipi && short === finalQuery) return 1;
        // Tier 2: prefix match
        if (short.startsWith(finalQuery) || full.startsWith(finalQuery)) return 2;
        // Tier 3: fuzzy
        return 3;
      };

      // Build final list based on query context
      let finalItems: AutocompleteItem[];

      if (isExplicitSkillQuery) {
        // User explicitly wants skill commands — show them first
        finalItems = [...skillItems, ...enhancedUnipiItems, ...systemItems];
      } else {
        // Merge unipi + system items, sorted by 4-tier quality then source
        const tagged: Array<{ item: AutocompleteItem; isUnipi: boolean }> = [
          ...systemItems.map((item) => ({ item, isUnipi: false })),
          ...enhancedUnipiItems.map((item) => ({ item, isUnipi: true })),
        ];

        tagged.sort((a, b) => {
          const priA = crossItemPriority(a.item, a.isUnipi);
          const priB = crossItemPriority(b.item, b.isUnipi);
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

        finalItems = tagged.map((t) => t.item);
      }

      return {
        items: finalItems,
        prefix: effectivePrefix,
      };
    },

    applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
    ): boolean {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);

      // When Tab is pressed inside a /unipi:* argument context we still
      // want getSuggestions to be called (returning true here allows that),
      // and getSuggestions will override force=false so the base provider
      // takes the argument-completion path instead of the file path.
      if (isInUnipiArgPosition(textBeforeCursor)) {
        return true;
      }

      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}
