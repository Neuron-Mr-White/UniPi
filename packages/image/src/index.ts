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
import {
  applyRecognizeGating,
  isVisionModel,
  listImageGenModels,
  listVisionModels,
  type ChatModelRegistry,
} from "./models.js";
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

/**
 * Hide image_recognize when the session model can natively see images, and
 * restore it when a text-only model takes over. Returns whether the tool is
 * provided after gating.
 */
function applyVisionGating(pi: ExtensionAPI, model: unknown): boolean {
  const active = pi.getActiveTools();
  const next = applyRecognizeGating(active, model, IMAGE_TOOLS.RECOGNIZE);
  if (next !== active) pi.setActiveTools(next);
  return next.includes(IMAGE_TOOLS.RECOGNIZE);
}

export default function (pi: ExtensionAPI) {
  registerImageTools(pi);
  registerImageCommands(pi);

  pi.on("model_select", (event) => {
    if (!loadConfig().recognize.enabled) return;
    applyVisionGating(pi, event.model);
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();

    // Bridge pi's configured providers into pi-ai's images collection up front,
    // so the settings picker and the info screen see them without a prior
    // image_generate call. Best-effort: never block session start.
    void registerRegistryImageProviders(
      (ctx as unknown as { modelRegistry?: ChatModelRegistry }).modelRegistry,
    ).catch(() => undefined);

    // A vision-capable session model reads images itself, so image_recognize
    // would only duplicate that ability. Drop it from the active tool set;
    // the model_select handler above restores it when a text-only model is
    // chosen later in the same session.
    const recognizeProvided =
      config.recognize.enabled && applyVisionGating(pi, ctx.model);

    const tools: string[] = [];
    if (config.generate.enabled) tools.push(IMAGE_TOOLS.GENERATE);
    if (recognizeProvided) tools.push(IMAGE_TOOLS.RECOGNIZE);

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

        const recognize = !current.recognize.enabled
          ? "Disabled"
          : isVisionModel(ctx.model)
            ? "Hidden (model has vision)"
            : current.recognize.model || "Session model";

        return {
          generate: { value: generate },
          recognize: { value: recognize },
          visionModels: { value: String(vision.length) },
        };
      },
    });
  });
}
