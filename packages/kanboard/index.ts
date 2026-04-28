/**
 * @pi-unipi/kanboard — Extension entry
 *
 * Visualization layer for unipi workflow data.
 * HTTP server with htmx + Alpine.js UI, modular parsers, TUI overlay, and kanban board.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

  // TODO: Register commands, info-screen group, TUI overlay
}
