/**
 * @pi-unipi/image — Extension entry
 *
 * Provides the `image_generate` and `image_recognize` agent tools plus the
 * `/unipi:image-settings` command.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  IMAGE_COMMANDS,
  IMAGE_TOOLS,
  MODULES,
  UNIPI_EVENTS,
  UNIPI_PREFIX,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";

import { registerImageCommands } from "./commands.js";
import { registerImageTools } from "./tools.js";
import { listImageGenModels, listVisionModels, type ChatModelRegistry } from "./models.js";
import { registerRegistryImageProviders } from "./register-providers.js";
import { loadConfig } from "./settings.js";

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Info-screen registry, read off the global to avoid load-order coupling. */
function getInfoRegistry() {
  return (
    globalThis as {
      __unipi_info_registry?: {
        registerGroup(group: unknown): void;
      };
    }
  ).__unipi_info_registry;
}

export default function (pi: ExtensionAPI) {
  registerImageTools(pi);
  registerImageCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();

    // Bridge pi's configured providers into pi-ai's images collection up front,
    // so the settings picker and the info screen see them without a prior
    // image_generate call. Best-effort: never block session start.
    void registerRegistryImageProviders(
      (ctx as unknown as { modelRegistry?: ChatModelRegistry }).modelRegistry,
    ).catch(() => undefined);

    const tools: string[] = [];
    if (config.generate.enabled) tools.push(IMAGE_TOOLS.GENERATE);
    if (config.recognize.enabled) tools.push(IMAGE_TOOLS.RECOGNIZE);

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.IMAGE,
      version: VERSION,
      commands: [`${UNIPI_PREFIX}${IMAGE_COMMANDS.SETTINGS}`],
      tools,
    });

    const registry = getInfoRegistry();
    if (!registry) return;

    registry.registerGroup({
      id: "image",
      name: "Image",
      icon: "🎨",
      priority: 55,
      config: {
        showByDefault: true,
        stats: [
          { id: "generate", label: "Generate", show: true },
          { id: "recognize", label: "Recognize", show: true },
          { id: "visionModels", label: "Vision Models", show: true },
        ],
      },
      dataProvider: async () => {
        const current = loadConfig();

        const genModels = await listImageGenModels();
        const generate = current.generate.enabled
          ? genModels.length > 0
            ? current.generate.model
            : "No image models available"
          : "Disabled";

        const chatRegistry = (ctx as unknown as { modelRegistry?: ChatModelRegistry })
          .modelRegistry;
        const vision = chatRegistry ? listVisionModels(chatRegistry) : [];

        const recognize = current.recognize.enabled
          ? current.recognize.model || "Session model"
          : "Disabled";

        return {
          generate: { value: generate },
          recognize: { value: recognize },
          visionModels: { value: String(vision.length) },
        };
      },
    });
  });
}
