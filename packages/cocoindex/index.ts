/**
 * @pi-unipi/cocoindex — CocoIndex integration for Pi
 *
 * Bridges Pi to CocoIndex CLI for AST-aware content indexing,
 * semantic vector search, and incremental pipeline management.
 *
 * Default target store: LanceDB (zero-config, local file-based).
 * Embedding model: reuses memory package settings (OpenRouter API key + model).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODULES, UNIPI_EVENTS, COCOINDEX_TOOLS, COCOINDEX_COMMANDS, COCOINDEX_PACKAGE_SPEC, emitEvent } from "@pi-unipi/core";
import { registerCocoindexTools } from "./tools.js";
import { registerCocoindexCommands } from "./commands.js";
import * as bridge from "./bridge.js";

export default function cocoindexExtension(pi: ExtensionAPI): void {
  // Register commands and static tool definitions at extension load. Tool
  // executors resolve ctx.cwd per call, so session_start never changes schemas.
  registerCocoindexCommands(pi);
  registerCocoindexTools(pi, {
    getProjectDir: (ctx) => ctx.cwd ?? process.cwd(),
  });

  pi.on("session_start", async (_event, ctx) => {
    const projectDir = ctx.cwd ?? process.cwd();

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.COCOINDEX,
      version: "0.1.0",
      commands: Object.values(COCOINDEX_COMMANDS),
      tools: Object.values(COCOINDEX_TOOLS),
    });

    const available = await bridge.isAvailable();
    if (available) {
      ctx.ui.notify("📦 CocoIndex ready", "info");
    } else {
      ctx.ui.notify(
        `📦 CocoIndex: CLI not found — run /unipi:cocoindex-init for guided install (manual: uv tool install '${COCOINDEX_PACKAGE_SPEC}').`,
        "info",
      );
    }
  });
}

export { bridge };
export * as installer from "./installer.js";
