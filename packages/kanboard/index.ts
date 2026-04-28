/**
 * @pi-unipi/kanboard — Extension entry
 *
 * Visualization layer for unipi workflow data.
 * HTTP server with htmx + Alpine.js UI, modular parsers, TUI overlay, and kanban board.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODULES, KANBOARD_COMMANDS } from "@pi-unipi/core";
import { registerCommands } from "./commands.js";

/** Package version */
const VERSION = "0.1.0";

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
