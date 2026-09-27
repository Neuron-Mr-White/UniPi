/**
 * @pi-unipi/compactor — Extension entry point
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODULES, UNIPI_EVENTS, COMPACTOR_COMMANDS, COMPACTOR_TOOLS, emitEvent } from "@pi-unipi/core";
import { migrateLegacyConfigFiles } from "./config/manager.js";
import { registerCompactionHooks } from "./compaction/hooks.js";
import { registerCommands } from "./commands/index.js";
import { registerCompactorTools } from "./tools/register.js";
import type { RuntimeCounters } from "./types.js";

export default function compactorExtension(pi: ExtensionAPI): void {
  const counters: RuntimeCounters = { recallQueries: 0, compactions: 0 };
  let getBranch: () => readonly any[] = () => [];

  registerCompactionHooks(pi, { counters });
  registerCompactorTools(pi, { counters });
  registerCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    migrateLegacyConfigFiles(ctx.cwd);
    getBranch = () => {
      try {
        return ctx.sessionManager.getBranch();
      } catch {
        return [];
      }
    };

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
            { id: "tokensSaved", label: "Tokens saved", show: true },
            { id: "costSaved", label: "Cost saved", show: true },
            { id: "pctReduction", label: "% Reduction", show: true },
            { id: "topTools", label: "Top tools", show: true },
            { id: "compactions", label: "Compactions", show: true },
            { id: "toolCalls", label: "Tool calls", show: true },
          ],
        },
        dataProvider: async () => {
          try {
            const { getInfoScreenData } = await import("./info-screen.js");
            return { ...(await getInfoScreenData(getBranch())) };
          } catch {
            return {};
          }
        },
      });
    }

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
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
