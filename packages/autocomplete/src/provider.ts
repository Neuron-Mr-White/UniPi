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

  // Sort: boosted package first, then by PACKAGE_ORDER, then alphabetically.
  matched.sort((a, b) => {
    const pkgA = a[1];
    const pkgB = b[1];

    if (boostedPackage) {
      const aIsBoosted = pkgA === boostedPackage;
      const bIsBoosted = pkgB === boostedPackage;
      if (aIsBoosted && !bIsBoosted) return -1;
      if (!aIsBoosted && bIsBoosted) return 1;
    }

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

      // If no unipi items match, just return non-unipi (or null if empty)
      if (enhancedUnipiItems.length === 0) {
        return nonUnipiItems.length > 0
          ? { items: nonUnipiItems, prefix: effectivePrefix }
          : null;
      }

      // Merge: non-unipi first, then enhanced unipi (sorted by package)
      return {
        items: [...nonUnipiItems, ...enhancedUnipiItems],
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
