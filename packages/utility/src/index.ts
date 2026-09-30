/**
 * @pi-unipi/utility — Extension entry
 *
 * - /unipi:settings — the unified settings hub
 * - /unipi:continue (/unipi:retry), /unipi:cleanup, /unipi:doctor, /unipi:answer
 * - Automatic session naming (jev gate + isolated one-tool session) + Herdr sync
 * - Pasted images/files → [Image #N] / [File #N] attachments
 * - Image tools: image_generate, image_edit, image_recognize
 * - Response formatting: simple | regular | advanced tool rendering
 * - The shared model cache (~/.unipi/config/models-cache.json)
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  UTILITY_COMMANDS,
  emitEvent,
  getPackageVersion,
  openSettingsHub,
  chatModelsToCache,
  writeModelCache,
} from "@pi-unipi/core";
import { registerUtilityCommands } from "./commands.js";
import { registerAutoRename } from "./rename/index.js";
import { registerAnswerCommand } from "./answer/index.js";
import { registerAttachments } from "./attach/index.js";
import { imageCatalogEntries, loadImageConfig, refreshImageModelCache, registerImage } from "./image/index.js";
import { registerToolRenderers } from "./render/tools.js";
import { installTranscriptSpacing } from "./render/spacing.js";
import { readUtilSettings } from "./settings.js";

export { readUtilSettings } from "./settings.js";
export { simpleWrapTool, simpleWrapped, installSimpleGroupEvents } from "./render/simple.js";

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

const ALL_COMMANDS = [
  UTILITY_COMMANDS.CONTINUE,
  UTILITY_COMMANDS.RETRY,
  UTILITY_COMMANDS.CLEANUP,
  UTILITY_COMMANDS.DOCTOR,
  UTILITY_COMMANDS.ANSWER,
  "settings",
].map((cmd) => `unipi:${cmd}`);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("unipi:settings", {
    description: "Configure all unipi modules in one panel (global + project scopes); /unipi:settings <search> opens it filtered",
    handler: async (args, ctx) => openSettingsHub(ctx, { filter: args.trim() }),
  });

  registerUtilityCommands(pi);
  registerAutoRename(pi);
  registerAnswerCommand(pi);
  registerAttachments(pi);
  registerImage(pi);
  registerToolRenderers(pi, readUtilSettings().render.style);
  // Normalize blank runs between transcript blocks (all render styles).
  installTranscriptSpacing(pi);

  pi.on("session_start", async (_event, ctx) => {
    try {
      emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
        name: MODULES.UTILITY,
        version: VERSION,
        commands: ALL_COMMANDS,
        tools: [],
      });
      // Refresh the shared model cache: image models first (their real
      // modalities win over the chat registry's text-only view), then pi's
      // live chat registry (models with credentials, else the full registry).
      const registry = ctx.modelRegistry as unknown as { getAvailable?: () => unknown[]; getAll?: () => unknown[] } | undefined;
      const available = registry?.getAvailable?.() ?? [];
      const chat = chatModelsToCache(available.length > 0 ? available : registry?.getAll?.() ?? []);
      const write = () => writeModelCache([...imageCatalogEntries(loadImageConfig(ctx.cwd)), ...chat]);
      if (chat.length > 0) write();
      void refreshImageModelCache().then((changed) => {
        if (changed && chat.length > 0) write();
      });
    } catch {
      // Best effort — never block session start.
    }
  });
}
