/**
 * @pi-unipi/compactor — Extension entry point
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { bus, MODULES, UNIPI_EVENTS, COMPACTOR_COMMANDS, COMPACTOR_TOOLS } from "@pi-unipi/core";
import { migrateLegacyConfigFiles } from "./config/manager.js";
import { registerCompactionHooks } from "./compaction/hooks.js";
import { registerCommands } from "./commands/index.js";
import { registerCompactorTools } from "./tools/register.js";
import type { RuntimeCounters } from "./types.js";
import { CARD_TYPE, renderCompactionCard, type CompactionCardData } from "./card.js";
import type { KitTheme } from "@pi-unipi/core";

const COMPACT_THEN_ITEM: AutocompleteItem = {
  value: "unipi:compact-then",
  label: "unipi:compact-then",
  description: "Compacts, then sends a prompt once it lands (not a registered command)",
};

/**
 * `/unipi:compact-then` has no `pi.registerCommand` (it is recognized
 * directly in the `input` handler, see compaction/hooks.ts), so it is
 * absent from `ctx.getCommands()` and the base autocomplete provider's
 * command list. This wrapper adds a single synthetic suggestion for it
 * at the command-name position, leaving every other suggestion (including
 * argument completions) to the wrapped provider unchanged.
 */
export function createCompactThenAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
  return {
    applyCompletion: (...args) => current.applyCompletion(...args),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      // Command-name position only: a leading slash, no space yet.
      if (!textBeforeCursor.startsWith("/") || textBeforeCursor.includes(" ")) return base;
      const query = textBeforeCursor.slice(1).toLowerCase();
      if (!"unipi:compact-then".includes(query) && !"compact-then".startsWith(query)) return base;
      const prefix = base?.prefix ?? textBeforeCursor;
      const items = base ? [...base.items, COMPACT_THEN_ITEM] : [COMPACT_THEN_ITEM];
      return { items, prefix };
    },
  };
}

export default function compactorExtension(pi: ExtensionAPI): void {
  const counters: RuntimeCounters = { recallQueries: 0, compactions: 0 };
  let getBranch: () => readonly any[] = () => [];

  registerCompactionHooks(pi, { counters });
  registerCompactorTools(pi, { counters });
  registerCommands(pi);

  try {
    pi.registerEntryRenderer?.<CompactionCardData>(CARD_TYPE, (entry, options, theme) =>
      entry.data ? renderCompactionCard(entry.data, Boolean(options?.expanded), theme as unknown as KitTheme) : undefined,
    );
  } catch {
    // UI-less modes.
  }

  pi.on("session_start", async (_event, ctx) => {
    migrateLegacyConfigFiles(ctx.cwd);
    const cwd = ctx.cwd;
    getBranch = () => {
      try {
        return ctx.sessionManager.getBranch();
      } catch {
        return [];
      }
    };

    if (ctx.hasUI) {
      try {
        ctx.ui.addAutocompleteProvider(createCompactThenAutocompleteProvider);
      } catch {
        // Autocomplete is a nicety; /unipi:compact-then still works typed in full.
      }
    }

    const infoRegistry = globalThis.__unipi_info_registry;
    if (infoRegistry) {
      infoRegistry.registerGroup({
        id: "compactor",
        name: "Compactor",
        icon: "🗜️",
        priority: 12,
        config: {
          showByDefault: true,
          stats: [
            { id: "settings", label: "Method", show: true },
            { id: "compactions", label: "Compactions", show: true },
            { id: "tokens", label: "Tokens", show: true },
            { id: "last", label: "Last", show: true },
          ],
        },
        dataProvider: async () => {
          try {
            const { getInfoScreenData } = await import("./info-screen.js");
            return { ...getInfoScreenData(getBranch(), cwd) };
          } catch {
            return {};
          }
        },
      });
    }

    bus.emit(UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.COMPACTOR,
      version: "0.2.0",
      commands: Object.values(COMPACTOR_COMMANDS),
      tools: Object.values(COMPACTOR_TOOLS),
    });
  });

  // Width-safe diff truncation for edit/write tool results: Pi's renderDiff()
  // does not truncate lines to terminal width, which crashes narrow terminals.
  pi.on("tool_result", async (event) => {
    const toolName = (event as any).toolName ?? "";
    if (!["edit", "Edit", "write", "Write"].includes(toolName)) return;
    const details = (event as any).details as { diff?: string } | undefined;
    if (!details?.diff) return;
    try {
      const { clampDiffToWidth } = await import("./display/diff-width-safety.js");
      const clamped = clampDiffToWidth(details.diff);
      if (clamped !== details.diff) return { details: { ...details, diff: clamped } } as any;
    } catch {
      // Display nicety only.
    }
  });
}
