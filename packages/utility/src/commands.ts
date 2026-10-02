/**
 * @pi-unipi/utility — Commands
 *
 *   /unipi:continue (/unipi:retry) — take another turn without adding user text
 *   /unipi:cleanup [--dry-run|--yes] — allowlisted stale files, preview + confirm
 *   /unipi:doctor                     — runtime diagnostics
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { harnessMetadata, UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";
import { findCleanupItems, formatBytes, formatCleanupPreview, removeCleanupItems } from "./lifecycle/cleanup.js";
import { runDiagnostics, formatDiagnosticsReport } from "./diagnostics/engine.js";

/** Send a markdown response via pi.sendMessage */
function sendResponse(pi: ExtensionAPI, markdown: string): void {
  pi.sendMessage(
    {
      customType: "unipi-response",
      content: markdown,
      display: true,
      details: { unipiHarness: harnessMetadata({ source: "Utility", title: "Response", synopsis: "Command response" }, "followUp") },
    },
    { deliverAs: "followUp" },
  );
}

function busy(ctx: ExtensionContext): boolean {
  if (ctx.isIdle()) return false;
  if (ctx.hasUI) ctx.ui.notify("Agent is busy. Press ESC to interrupt, then try again.", "warning");
  return true;
}

export function registerUtilityCommands(pi: ExtensionAPI): void {
  const continueHandler = async (_args: string, ctx: ExtensionContext) => {
    if (busy(ctx)) return;
    pi.sendMessage({ customType: "unipi-continue", content: "", display: false }, { triggerTurn: true });
  };
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.CONTINUE}`, {
    description: "Continue the agent from where it left off, without adding text (/unipi:retry)",
    handler: continueHandler,
  });
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.RETRY}`, {
    description: "Retry the last turn — alias of /unipi:continue",
    handler: continueHandler,
  });

  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.CLEANUP}`, {
    description: "Remove stale UniPi temp files and leftovers (preview first)",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (busy(ctx)) return;
      const items = findCleanupItems();
      const preview = formatCleanupPreview(items);
      if (items.length === 0 || args.includes("--dry-run")) {
        sendResponse(pi, `## Cleanup${args.includes("--dry-run") ? " (dry run)" : ""}\n\n\`\`\`\n${preview}\n\`\`\``);
        return;
      }
      const confirmed = args.includes("--yes")
        || (ctx.hasUI && await ctx.ui.confirm("Remove these files?", preview));
      if (!confirmed) {
        sendResponse(pi, `## Cleanup cancelled\n\n\`\`\`\n${preview}\n\`\`\`${ctx.hasUI ? "" : "\n\nRun `/unipi:cleanup --yes` to remove them."}`);
        return;
      }
      const result = removeCleanupItems(items);
      const failed = result.failed.length ? `\n\nCould not remove:\n${result.failed.map((p) => `- \`${p}\``).join("\n")}` : "";
      sendResponse(pi, `## Cleanup\n\nRemoved ${result.removed} item(s), ${formatBytes(result.bytes)}.${failed}`);
    },
  });

  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.DOCTOR}`, {
    description: "Check UniPi's runtime: folders, config, model cache, Decision Model, skills",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (busy(ctx)) return;
      sendResponse(pi, formatDiagnosticsReport(await runDiagnostics()));
    },
  });
}
