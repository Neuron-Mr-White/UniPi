/**
 * @pi-unipi/kanboard — Extension entry
 *
 * Visualization layer for unipi workflow data.
 * HTTP server with htmx + Alpine.js UI, modular parsers, TUI overlay, and kanban board.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODULES, KANBOARD_COMMANDS, UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import { registerCommands } from "./commands.js";

/** Package version */
const VERSION = "0.1.0";

/** Whether we've seen the first user message (for auto badge generation) */
let firstMessageSeen = false;

/**
 * Check if auto badge generation on first message is enabled.
 * Reads from ~/.pi/agent/settings.json under unipi.kanboard.autoBadgeGen.
 * Defaults to true.
 */
function isAutoBadgeGenEnabled(): boolean {
  try {
    const settingsPath = path.join(homedir(), ".pi", "agent", "settings.json");
    if (!fs.existsSync(settingsPath)) return true;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const kanboard = settings?.unipi?.kanboard;
    if (kanboard && typeof kanboard.autoBadgeGen === "boolean") {
      return kanboard.autoBadgeGen;
    }
    return true;
  } catch {
    return true;
  }
}

export default function (pi: ExtensionAPI): void {
  // Register skills directory
  const skillsDir = new URL("./skills", import.meta.url).pathname;

  pi.on("resources_discover", async () => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Register commands
  registerCommands(pi);

  // Hook: on first user message, trigger async badge generation
  pi.on("input", async (event) => {
    // Only trigger on first user message
    if (firstMessageSeen) return;
    firstMessageSeen = true;

    // Check if auto badge generation is enabled (configurable)
    if (!isAutoBadgeGenEnabled()) return;

    // Skip if badge already has a name
    const sessionName = pi.getSessionName?.();
    if (sessionName) return;

    // Emit event so utility can show badge overlay
    emitEvent(pi, UNIPI_EVENTS.BADGE_GENERATE_REQUEST, {
      source: "input-hook",
    });

    // Send hidden message to LLM to generate session name
    pi.sendMessage(
      {
        customType: "badge-gen",
        content: [
          "[System Instruction: Analyze this conversation and generate a concise session title.",
          "Call the set_session_name tool with a name that is MAXIMUM 5 WORDS.",
          "The name should capture the main topic or task being worked on.",
          "Do not explain your reasoning. Just call set_session_name.]",
        ].join(" "),
        display: false,
      },
      { triggerTurn: true },
    );
  });

  // Register info-screen group
  const globalObj = globalThis as any;
  const registry = globalObj.__unipi_info_registry;
  if (registry) {
    registry.registerGroup({
      id: "kanboard",
      name: "Kanboard",
      icon: "📋",
      priority: 50,
      config: {
        showByDefault: true,
        stats: [
          { id: "status", label: "Server Status", show: true },
          { id: "url", label: "URL", show: true },
          { id: "docs", label: "Documents", show: true },
          { id: "tasks", label: "Tasks", show: true },
        ],
      },
      dataProvider: async () => {
        const { createDefaultRegistry } = await import("./parser/index.js");
        const registry = await createDefaultRegistry();
        const docs = registry.parseAll(".unipi/docs");
        const totalItems = docs.reduce((sum, d) => sum + d.items.length, 0);
        const doneItems = docs.reduce(
          (sum, d) => sum + d.items.filter((i) => i.status === "done").length,
          0,
        );

        return {
          status: {
            value: "Ready",
            detail: "Server not running (use /unipi:kanboard to start)",
          },
          url: {
            value: "—",
            detail: "Start server to get URL",
          },
          docs: {
            value: String(docs.length),
            detail: `${docs.length} documents parsed`,
          },
          tasks: {
            value: `${doneItems}/${totalItems}`,
            detail: `${totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0}% complete`,
          },
        };
      },
    });
  }
}
