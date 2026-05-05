/**
 * @pi-unipi/cocoindex — CocoIndex integration for Pi
 *
 * Bridges Pi to CocoIndex CLI for AST-aware content indexing,
 * semantic vector search, and incremental pipeline management.
 *
 * Default target store: LanceDB (zero-config, local file-based).
 * Embedding model: reuses memory package settings (OpenRouter API key + model).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODULES, UNIPI_EVENTS, COCOINDEX_TOOLS, COCOINDEX_COMMANDS, emitEvent } from "@pi-unipi/core";
import { registerCocoindexTools } from "./tools.js";
import { registerCocoindexCommands } from "./commands.js";
import * as bridge from "./bridge.js";

export default function cocoindexExtension(pi: ExtensionAPI): void {
  // Register commands at extension load time (synchronous).
  // Commands resolve projectDir from ctx.cwd at handler invocation time.
  registerCocoindexCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    const projectDir = (ctx as any).cwd ?? process.cwd();

    // Register tools — these need projectDir for search context
    const pipelineDir = bridge.getPipelineDir(projectDir);
    const initialized = await bridge.isPipelineInitialized(pipelineDir);

    registerCocoindexTools(pi, {
      projectDir,
      pipelineDir,
      initialized,
    });

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
      ctx.ui.notify("📦 CocoIndex: CLI not found — install with `pip install cocoindex`", "info");
    }
  });
}

export { bridge };
