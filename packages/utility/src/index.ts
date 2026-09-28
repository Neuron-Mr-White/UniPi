/**
 * @pi-unipi/utility — Extension entry
 *
 * - /unipi:settings — the unified settings hub
 * - /unipi:continue (/unipi:retry), /unipi:cleanup, /unipi:doctor
 * - Automatic session naming (jev gate + isolated one-tool session) + Herdr sync
 * - Skill exposure (judged | all | off)
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
  runCommandByName,
  SettingsHub,
  HUB_OVERLAY_OPTIONS,
  chatModelsToCache,
  writeModelCache,
} from "@pi-unipi/core";
import { registerUtilityCommands } from "./commands.js";
import { registerSkillJudging } from "./skill-discovery.js";
import { registerAutoRename } from "./rename/index.js";
import "./settings.js";

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

const ALL_COMMANDS = [
  UTILITY_COMMANDS.CONTINUE,
  UTILITY_COMMANDS.RETRY,
  UTILITY_COMMANDS.CLEANUP,
  UTILITY_COMMANDS.DOCTOR,
  "settings",
].map((cmd) => `unipi:${cmd}`);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("unipi:settings", {
    description: "Configure all unipi modules in one panel (global + project scopes)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error("/unipi:settings needs the interactive TUI");
      await ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) => {
          const hub = new SettingsHub({
            cwd: ctx.cwd ?? process.cwd(),
            runAction: async (command) => {
              const ran = await runCommandByName(command, ctx);
              if (!ran) ctx.ui.notify(`no handler registered for ${command}`, "warning");
            },
          });
          hub.onClose = () => done();
          return {
            focused: true,
            invalidate: () => hub.invalidate(),
            render: (width: number) => hub.render(width),
            handleInput: (data: string) => {
              hub.handleInput(data);
              tui.requestRender();
            },
            dispose: () => {},
          };
        },
        HUB_OVERLAY_OPTIONS,
      ).catch(() => {
        // Overlay errors are non-blocking.
      });
    },
  });

  registerSkillJudging(pi);
  registerUtilityCommands(pi);
  registerAutoRename(pi);

  pi.on("session_start", async (_event, ctx) => {
    try {
      emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
        name: MODULES.UTILITY,
        version: VERSION,
        commands: ALL_COMMANDS,
        tools: [],
      });
      // Refresh the shared model cache from pi's live registry (models with
      // credentials first; the full registry when nothing is authenticated).
      const registry = ctx.modelRegistry as unknown as { getAvailable?: () => unknown[]; getAll?: () => unknown[] } | undefined;
      const available = registry?.getAvailable?.() ?? [];
      const models = available.length > 0 ? available : registry?.getAll?.() ?? [];
      if (models.length > 0) writeModelCache(chatModelsToCache(models));
    } catch {
      // Best effort — never block session start.
    }
  });
}
