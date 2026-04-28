/**
 * @pi-unipi/utility — Command registration
 *
 * Registers all utility commands:
 * - /unipi:continue — existing, preserved
 * - /unipi:reload — reload all extensions
 * - /unipi:status — show module status
 * - /unipi:cleanup — clean stale files
 * - /unipi:env — show environment
 * - /unipi:doctor — run diagnostics
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_PREFIX,
  UTILITY_COMMANDS,
  UNIPI_EVENTS,
  emitEvent,
} from "@pi-unipi/core";
import { cleanupStale, formatCleanupReport } from "./lifecycle/cleanup.js";
import { runDiagnostics, formatDiagnosticsReport } from "./diagnostics/engine.js";
import { getEnvironmentInfo, formatEnvironmentInfo } from "./tools/env.js";
import type { NameBadgeState } from "./tui/name-badge-state.js";

/** Send a markdown response via pi.sendMessage */
function sendResponse(pi: ExtensionAPI, markdown: string): void {
  pi.sendMessage(
    {
      customType: "unipi-response",
      content: markdown,
      display: true,
    },
    { deliverAs: "followUp" },
  );
}

/**
 * Register name badge commands: /unipi:name-badge, /unipi:badge-gen.
 */
export function registerNameBadgeCommands(
  pi: ExtensionAPI,
  state: NameBadgeState,
): void {
  // ─── /unipi:name-badge — toggle badge overlay ───────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.NAME_BADGE}`, {
    description: "Toggle session name badge overlay",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Name badge requires an interactive UI.", "warning");
        return;
      }

      const nowVisible = await state.toggle(pi, ctx);
      ctx.ui.notify(
        nowVisible ? "Name badge enabled" : "Name badge disabled",
        "info",
      );
    },
  });

  // ─── /unipi:badge-gen — generate name via LLM ──────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.BADGE_GEN}`, {
    description: "Generate session name via LLM and enable badge",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Badge generation requires an interactive UI.", "warning");
        return;
      }

      await state.generate(pi, ctx);
      ctx.ui.notify("Generating session name...", "info");
    },
  });
}

/**
 * Register all utility commands.
 */
export function registerUtilityCommands(pi: ExtensionAPI): void {
  // ─── /unipi:continue — preserved ─────────────────────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.CONTINUE}`, {
    description: "Continue the agent from where it left off without adding user context",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Agent is busy. Press ESC to interrupt, then try again.",
            "warning",
          );
        }
        return;
      }

      pi.sendMessage(
        {
          customType: "unipi-continue",
          content: "",
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });

  // ─── /unipi:reload ───────────────────────────────────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.RELOAD}`, {
    description: "Reload all Pi extensions without restarting",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent is busy. Press ESC to interrupt first.", "warning");
        }
        return;
      }

      sendResponse(
        pi,
        "## 🔄 Reload Extensions\n\n" +
          "To reload all extensions:\n" +
          "1. Press **Ctrl+C** to exit Pi\n" +
          "2. Run `pi` again to restart with fresh extensions\n\n" +
          "*Note: Pi does not support hot-reloading of extensions.*",
      );
    },
  });

  // ─── /unipi:status ───────────────────────────────────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.STATUS}`, {
    description: "Show all unipi modules status",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent is busy. Press ESC to interrupt first.", "warning");
        }
        return;
      }

      // Request status from all modules — responses will be logged
      const requestId = `status-${Date.now()}`;
      emitEvent(pi, UNIPI_EVENTS.MODULE_STATUS_REQUEST, { requestId });

      // Give modules a moment to respond, then show what we know
      await new Promise((resolve) => setTimeout(resolve, 500));

      sendResponse(
        pi,
        "## 📊 Module Status\n\n" +
          "Status request broadcast to all modules.\n" +
          "Modules that support status reporting will respond via events.\n\n" +
          `*Request ID: \`${requestId}\`*`,
      );
    },
  });

  // ─── /unipi:cleanup ──────────────────────────────────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.CLEANUP}`, {
    description: "Clean temp files, stale DBs, old sessions",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent is busy. Press ESC to interrupt first.", "warning");
        }
        return;
      }

      const dryRun = args.includes("--dry-run");
      const report = cleanupStale({ dryRun });

      emitEvent(pi, UNIPI_EVENTS.UTILITY_CLEANUP_DONE, {
        dryRun,
        categories: ["db", "temp", "session", "cache"],
        results: report.results.map((r) => ({
          category: r.category,
          removed: r.removed,
          bytesFreed: r.bytesFreed,
        })),
      });

      sendResponse(pi, formatCleanupReport(report));
    },
  });

  // ─── /unipi:env ──────────────────────────────────────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.ENV}`, {
    description: "Show environment info (versions, paths)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent is busy. Press ESC to interrupt first.", "warning");
        }
        return;
      }

      const info = getEnvironmentInfo();
      sendResponse(pi, formatEnvironmentInfo(info));
    },
  });

  // ─── /unipi:doctor ───────────────────────────────────────────────────────
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.DOCTOR}`, {
    description: "Run diagnostics across all unipi modules",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent is busy. Press ESC to interrupt first.", "warning");
        }
        return;
      }

      emitEvent(pi, UNIPI_EVENTS.UTILITY_DIAGNOSTICS_START, {
        overall: "unknown",
        checkCount: 0,
      });

      const report = await runDiagnostics();

      emitEvent(pi, UNIPI_EVENTS.UTILITY_DIAGNOSTICS_DONE, {
        overall: report.overall,
        checkCount: report.checks.length,
        report,
      });

      sendResponse(pi, formatDiagnosticsReport(report));
    },
  });
}
