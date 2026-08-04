/**
 * @pi-unipi/image — Settings dialog
 *
 * Simple `ctx.ui.select` loop, matching the web-api settings pattern. The
 * model pickers are richer overlays (see model-selector.ts).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_CONFIG,
  DEFAULT_RECOGNIZE_SYSTEM_PROMPT,
  getOutputDir,
  loadConfig,
  saveConfig,
  type ImageConfig,
} from "../settings.js";
import {
  formatModelRef,
  listAllImageGenModels,
  listVisionModels,
  type ChatModelRegistry,
} from "../models.js";
import { ImageModelSelectorOverlay, type SelectableModel } from "./model-selector.js";

const EXIT = "__exit__";

function describe(config: ImageConfig): Array<{ value: string; label: string }> {
  return [
    {
      value: "__gen_model__",
      label: `🎨 Generation model — ${config.generate.model || "(none)"}`,
    },
    {
      value: "__gen_enabled__",
      label: `   image_generate tool — ${config.generate.enabled ? "enabled" : "disabled"}`,
    },
    {
      value: "__gen_save__",
      label: `   Save to disk — ${config.generate.saveToDisk ? "on" : "off"}`,
    },
    {
      value: "__gen_dir__",
      label: `   Output directory — ${config.generate.outputDir}`,
    },
    {
      value: "__rec_model__",
      label: `👁  Recognition model — ${config.recognize.model || "(session model)"}`,
    },
    {
      value: "__rec_enabled__",
      label: `   image_recognize tool — ${config.recognize.enabled ? "enabled" : "disabled"}`,
    },
    {
      value: "__rec_prompt__",
      label: `   System prompt — ${summarize(config.recognize.systemPrompt)}`,
    },
    { value: "__reset__", label: "↺  Reset to defaults" },
    { value: EXIT, label: "←  Back" },
  ];
}

function summarize(text: string, max = 45): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(empty)";
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** Show the settings dialog until the user backs out. */
export async function showSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  for (;;) {
    const config = loadConfig();
    const options = describe(config);
    const labels = options.map((o) => o.label);

    const picked = await ctx.ui.select("Image Settings", labels);
    if (!picked) return;

    const choice = options.find((o) => o.label === picked)?.value;
    if (!choice || choice === EXIT) return;

    await applyChoice(ctx, choice, config);
  }
}

async function applyChoice(
  ctx: ExtensionCommandContext,
  choice: string,
  config: ImageConfig,
): Promise<void> {
  switch (choice) {
    case "__gen_enabled__":
      config.generate.enabled = !config.generate.enabled;
      saveConfig(config);
      ctx.ui.notify(
        `image_generate ${config.generate.enabled ? "enabled" : "disabled"} — restart the session to apply.`,
        "info",
      );
      return;

    case "__rec_enabled__":
      config.recognize.enabled = !config.recognize.enabled;
      saveConfig(config);
      ctx.ui.notify(
        `image_recognize ${config.recognize.enabled ? "enabled" : "disabled"} — restart the session to apply.`,
        "info",
      );
      return;

    case "__gen_save__":
      config.generate.saveToDisk = !config.generate.saveToDisk;
      saveConfig(config);
      ctx.ui.notify(
        config.generate.saveToDisk
          ? `Generated images will be saved to ${getOutputDir(config)}`
          : "Generated images will be returned inline only.",
        "info",
      );
      return;

    case "__gen_dir__": {
      const value = await ctx.ui.input(
        "Output directory for generated images",
        config.generate.outputDir,
      );
      if (value?.trim()) {
        config.generate.outputDir = value.trim();
        saveConfig(config);
        ctx.ui.notify(`Output directory set to ${getOutputDir(config)}`, "info");
      }
      return;
    }

    case "__rec_prompt__": {
      const value = await ctx.ui.input(
        "System prompt for image recognition (blank to restore the default)",
        config.recognize.systemPrompt,
      );
      if (value === undefined) return;
      config.recognize.systemPrompt = value.trim() || DEFAULT_RECOGNIZE_SYSTEM_PROMPT;
      saveConfig(config);
      ctx.ui.notify("System prompt updated.", "info");
      return;
    }

    case "__gen_model__":
      await pickModel(ctx, "generate", config);
      return;

    case "__rec_model__":
      await pickModel(ctx, "recognize", config);
      return;

    case "__reset__":
      saveConfig(structuredClone(DEFAULT_CONFIG));
      ctx.ui.notify("Image settings reset to defaults.", "info");
      return;
  }
}

async function pickModel(
  ctx: ExtensionCommandContext,
  kind: "generate" | "recognize",
  config: ImageConfig,
): Promise<void> {
  const models = await collectModels(ctx, kind);

  if (models.length === 0) {
    ctx.ui.notify(
      kind === "generate"
        ? "No image models available. Add an OpenRouter key with /login, or register a provider that exposes image models."
        : "No vision-capable models configured. Add a model that accepts image input.",
      "warning",
    );
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("Model selection requires an interactive UI.", "warning");
    return;
  }

  const current =
    kind === "generate" ? config.generate.model : config.recognize.model;

  // `ctx.ui.custom` resolves only when the factory calls `done()`. It MUST be
  // awaited: returning early leaves the overlay on screen while the settings
  // loop mounts the next `ctx.ui.select`, so two focused components fight over
  // the same keystrokes and neither can be closed.
  let picked: string | undefined;

  try {
    picked = await ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        const overlay = new ImageModelSelectorOverlay(kind, models, current);
        overlay.setTheme(theme);
        overlay.requestRender = () => tui.requestRender();
        overlay.onSelect = (modelRef) => {
          picked = modelRef;
        };
        overlay.onClose = () => done(picked);
        return {
          render: (width: number) => overlay.render(width),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { width: "80%", minWidth: 50, anchor: "center", margin: 2 },
      },
    );
  } catch (err) {
    ctx.ui.notify(`Model selector error: ${err}`, "error");
    return;
  }

  // Persist only after the overlay has fully closed, so a cancel leaves the
  // existing config untouched.
  if (!picked) return;

  const next = loadConfig();
  if (kind === "generate") next.generate.model = picked;
  else next.recognize.model = picked;
  saveConfig(next);
  ctx.ui.notify(`${kind === "generate" ? "Generation" : "Recognition"} model set to ${picked}`, "info");
}

async function collectModels(
  ctx: ExtensionCommandContext,
  kind: "generate" | "recognize",
): Promise<SelectableModel[]> {
  const registry = (ctx as unknown as { modelRegistry?: ChatModelRegistry })
    .modelRegistry;

  if (kind === "generate") {
    // Include models from providers registered by other extensions, not just
    // pi-ai's built-in OpenRouter catalog.
    const models = await listAllImageGenModels(registry);
    return models.map((m) => ({ provider: m.provider, id: m.id, name: m.name }));
  }

  if (!registry) return [];

  return listVisionModels(registry).map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
  }));
}

export { formatModelRef };
