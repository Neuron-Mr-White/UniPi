/**
 * @unipi/memory — Settings TUI
 *
 * Interactive settings dialog for embedding configuration.
 * Uses ctx.ui primitives (select, input, notify).
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
  loadEmbeddingConfig,
  saveEmbeddingConfig,
  setApiKey,
  clearApiKey,
  getApiKey,
  isEmbeddingReady,
  hasModelChanged,
  markModelUsed,
  OPENROUTER_EMBEDDING_MODELS,
  type EmbeddingConfig,
} from "../settings.js";

/**
 * Show memory settings dialog.
 * Main entry point for /unipi:memory-settings command.
 */
export async function showMemorySettings(ctx: ExtensionCommandContext): Promise<void> {
  const ui = ctx.ui;
  let running = true;

  while (running) {
    const config = loadEmbeddingConfig();
    const hasKey = !!getApiKey();
    const ready = isEmbeddingReady();

    // Build status lines
    const statusLines = [
      `Provider: ${config.provider === "none" ? "None (fuzzy-only)" : "OpenRouter"}`,
      `Model: ${config.model || "N/A"}`,
      `Dimensions: ${config.dimensions}`,
      `API Key: ${hasKey ? "✓ Set" : "✗ Not set"}`,
      `Status: ${ready ? "✓ Ready" : "⚠ Not configured"}`,
    ];

    if (hasModelChanged() && !config.suppressMigrationWarning) {
      statusLines.push("");
      statusLines.push("⚠ Model changed — old embeddings incompatible.");
      statusLines.push("  Re-embed to use vector search with new model.");
    }

    const options = [];

    // API key management
    if (hasKey) {
      options.push({
        label: "🔑 Update API Key",
        value: "__update_key__",
        description: "Update your OpenRouter API key",
      });
      options.push({
        label: "🗑️ Remove API Key",
        value: "__remove_key__",
        description: "Remove API key and disable vector search",
      });
    } else {
      options.push({
        label: "🔑 Add API Key",
        value: "__add_key__",
        description: "Add OpenRouter API key to enable vector search",
      });
    }

    // Model selection
    options.push({
      label: `📦 Select Model (current: ${config.model})`,
      value: "__select_model__",
      description: "Choose embedding model from OpenRouter",
    });

    // Dimensions
    options.push({
      label: `📐 Dimensions: ${config.dimensions}`,
      value: "__dimensions__",
      description: "Embedding dimensions (lower = faster, less storage)",
    });

    // Re-embed
    if (ready && hasModelChanged()) {
      options.push({
        label: "🔄 Re-embed All Memories",
        value: "__reembed__",
        description: "Re-generate all embeddings with current model",
      });
    }

    // Suppress warning
    if (hasModelChanged() && !config.suppressMigrationWarning) {
      options.push({
        label: "🔕 Suppress Migration Warning",
        value: "__suppress__",
        description: "Hide the model change warning",
      });
    }

    options.push({
      label: "← Back",
      value: "__exit__",
      description: "Exit settings",
    });

    const labels = options.map(o => `${o.label} — ${o.description}`);
    const selected = await ui.select(
      "🧠 Memory Settings",
      labels,
    );
    // Map selected label back to value
    const selectedOpt = options.find(o => `${o.label} — ${o.description}` === selected);
    const selectedValue = selectedOpt?.value;

    if (!selectedValue || selectedValue === "__exit__") {
      running = false;
      continue;
    }

    switch (selectedValue) {
      case "__add_key__":
      case "__update_key__":
        await handleApiKeyInput(ui);
        break;
      case "__remove_key__":
        clearApiKey();
        ui.notify("API key removed. Vector search disabled.", "info");
        break;
      case "__select_model__":
        await handleModelSelection(ui);
        break;
      case "__dimensions__":
        await handleDimensionsInput(ui);
        break;
      case "__reembed__":
        await handleReembed(ui, ctx);
        break;
      case "__suppress__":
        const cfg = loadEmbeddingConfig();
        cfg.suppressMigrationWarning = true;
        saveEmbeddingConfig(cfg);
        ui.notify("Migration warning suppressed.", "info");
        break;
    }
  }
}

/**
 * Handle API key input.
 */
async function handleApiKeyInput(ui: ExtensionCommandContext["ui"]): Promise<void> {
  const key = await ui.input(
    "Enter your OpenRouter API key (sk-or-v1-...):",
    "sk-or-v1-...",
  );

  if (key) {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      ui.notify("API key cannot be empty.", "warning");
      return;
    }
    if (!trimmed.startsWith("sk-or-") && !trimmed.startsWith("sk-")) {
      ui.notify("Key should start with sk-or- or sk-.", "warning");
      return;
    }
    setApiKey(trimmed);
    ui.notify("API key saved. Vector search enabled.", "info");
  }
}

/**
 * Handle model selection.
 */
async function handleModelSelection(ui: ExtensionCommandContext["ui"]): Promise<void> {
  const config = loadEmbeddingConfig();

  const modelOptions = OPENROUTER_EMBEDDING_MODELS.map((m) => ({
    label: `${m.name}${m.id === config.model ? " ✓" : ""}`,
    value: m.id,
    description: `${m.description} (${m.dimensions}d, ~${m.costPer1k}/1k tokens)`,
  }));

  // Add custom option
  modelOptions.push({
    label: "✏️ Custom Model ID",
    value: "__custom__",
    description: "Enter a custom OpenRouter model ID",
  });

  const labels = modelOptions.map(o => `${o.label} — ${o.description}`);
  const selected = await ui.select(
    "Select Embedding Model",
    labels,
  );

  if (!selected) return;

  // Map label back to value
  const selectedOpt = modelOptions.find(o => `${o.label} — ${o.description}` === selected);
  let modelId = selectedOpt?.value;

  if (!modelId) return;

  if (modelId === "__custom__") {
    const custom = await ui.input(
      "Enter the OpenRouter model ID:",
      "openai/text-embedding-3-small",
    );
    if (!custom) return;
    modelId = custom.trim();
  }

  // Find model info for dimensions
  const modelInfo = OPENROUTER_EMBEDDING_MODELS.find((m) => m.id === modelId);
  const dimensions = modelInfo?.dimensions ?? 384;

  config.model = modelId;
  config.dimensions = dimensions;
  saveEmbeddingConfig(config);

  ui.notify(
    `Model set to ${modelId} (${dimensions}d).${hasModelChanged() ? " Re-embed existing memories to use new model." : ""}`,
    "info",
  );
}

/**
 * Handle dimensions input.
 */
async function handleDimensionsInput(ui: ExtensionCommandContext["ui"]): Promise<void> {
  const config = loadEmbeddingConfig();

  const dimStr = await ui.input(
    `Enter dimensions (default: 384). Lower = faster, less storage.\nNote: openai/text-embedding-3 supports 256-3072.\nada-002 only supports 1536.`,
    "384",
  );

  if (dimStr) {
    const dims = parseInt(dimStr, 10);
    if (isNaN(dims) || dims < 64 || dims > 3072) {
      ui.notify("Must be a number between 64 and 3072.", "warning");
      return;
    }
    config.dimensions = dims;
    saveEmbeddingConfig(config);

    ui.notify(`Dimensions set to ${dims}. Re-embed existing memories to apply.`, "info");
  }
}

/**
 * Handle re-embedding all memories.
 * This is a destructive operation — warns user first.
 */
async function handleReembed(ui: ExtensionCommandContext["ui"], ctx: ExtensionCommandContext): Promise<void> {
  const confirmOptions = [
    { label: "Yes, re-embed all — Proceed with re-embedding", value: "yes" },
    { label: "Cancel — Abort", value: "no" },
  ];
  const confirmLabels = confirmOptions.map(o => o.label);
  const confirm = await ui.select(
    "Re-embed All Memories",
    confirmLabels,
  );

  const confirmOpt = confirmOptions.find(o => o.label === confirm);
  if (confirmOpt?.value !== "yes") return;

  // Import here to avoid circular deps
  const { reembedAllMemories } = await import("../embedding.js");
  const count = await reembedAllMemories(ctx);

  markModelUsed();

  ui.notify(`Re-embedded ${count} memories with current model.`, "info");
}
