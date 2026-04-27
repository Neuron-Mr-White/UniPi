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

// ─── Enhanced item generation ────────────────────────────────────────

/**
 * Generate enhanced autocomplete items for unipi commands,
 * sorted by package order then alphabetically within each package.
 */
function getEnhancedUnipiItems(
  prefix: string,
  descriptionOverrides: Map<string, string> = new Map(),
): AutocompleteItem[] {
  // The prefix from the base provider includes the "/" and possibly "unipi:"
  // e.g., "/brain" → prefix is "/brain" or "brain"
  // e.g., "/unipi:brain" → prefix is "/unipi:brain"
  const query = prefix
    .replace(/^\//, "")
    .replace(/^unipi:/, "")
    .toLowerCase();

  const entries = Object.entries(COMMAND_REGISTRY);

  // Filter by fuzzy match on command name (without unipi: prefix)
  const matched = entries.filter(([cmd]) => {
    const cmdName = cmd.replace("unipi:", "").toLowerCase();
    return fuzzyMatch(cmdName, query);
  });

  // Sort by package order, then alphabetically within each package
  matched.sort((a, b) => {
    const orderA = PACKAGE_ORDER.indexOf(a[1]);
    const orderB = PACKAGE_ORDER.indexOf(b[1]);
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

      // Get base suggestions (includes all commands)
      const baseSuggestions = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      if (!baseSuggestions) return null;

      // Separate: keep non-unipi items, discard unipi items
      // Also collect descriptions from base items for unipi commands
      const nonUnipiItems: AutocompleteItem[] = [];
      const descriptionOverrides = new Map<string, string>();

      for (const item of baseSuggestions.items) {
        if (item.value.startsWith("unipi:")) {
          // Save the description from base suggestions
          if (item.description) {
            descriptionOverrides.set(item.value, item.description);
          }
        } else {
          nonUnipiItems.push(item);
        }
      }

      // Generate enhanced unipi items
      const enhancedUnipiItems = getEnhancedUnipiItems(
        baseSuggestions.prefix,
        descriptionOverrides,
      );

      // If no unipi items match, just return non-unipi
      if (enhancedUnipiItems.length === 0) {
        return nonUnipiItems.length > 0
          ? { items: nonUnipiItems, prefix: baseSuggestions.prefix }
          : null;
      }

      // Merge: non-unipi first, then enhanced unipi (sorted by package)
      return {
        items: [...nonUnipiItems, ...enhancedUnipiItems],
        prefix: baseSuggestions.prefix,
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
      return (
        current.shouldTriggerFileCompletion?.(
          lines,
          cursorLine,
          cursorCol,
        ) ?? true
      );
    },
  };
}
