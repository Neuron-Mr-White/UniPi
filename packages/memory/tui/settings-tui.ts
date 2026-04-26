/**
 * @unipi/memory — Settings TUI
 *
 * Interactive settings dialog for embedding configuration.
 * Uses pi's UI primitives (select, input, notify).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

/** pi.ui type that's available when TUI is present */
type PiUI = {
  select: (opts: { title: string; message: string; options: Array<{ label: string; value: string; description?: string }> }) => Promise<string | null | undefined>;
  input: (opts: { title: string; message: string; placeholder?: string; validate?: (value: string) => Promise<string | null> }) => Promise<string | null | undefined>;
  notify: (opts: { message: string; level: string }) => Promise<void>;
};

/**
 * Show memory settings dialog.
 * Main entry point for /unipi:memory-settings command.
 */
export async function showMemorySettings(pi: ExtensionAPI): Promise<void> {
  // Cast to access pi.ui which exists at runtime but isn't typed
  const ui = (pi as any).ui as PiUI;
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

    const selected = await ui.select({
      title: "🧠 Memory Settings",
      message: statusLines.join("\n"),
      options,
    });

    if (!selected || selected === "__exit__") {
      running = false;
      continue;
    }

    switch (selected) {
      case "__add_key__":
      case "__update_key__":
        await handleApiKeyInput(ui);
        break;
      case "__remove_key__":
        clearApiKey();
        await ui.notify({
          message: "API key removed. Vector search disabled.",
          level: "info",
        });
        break;
      case "__select_model__":
        await handleModelSelection(ui);
        break;
      case "__dimensions__":
        await handleDimensionsInput(ui);
        break;
      case "__reembed__":
        await handleReembed(ui, pi);
        break;
      case "__suppress__":
        const cfg = loadEmbeddingConfig();
        cfg.suppressMigrationWarning = true;
        saveEmbeddingConfig(cfg);
        await ui.notify({
          message: "Migration warning suppressed.",
          level: "info",
        });
        break;
    }
  }
}

/**
 * Handle API key input.
 */
async function handleApiKeyInput(ui: PiUI): Promise<void> {
  const key = await ui.input({
    title: "OpenRouter API Key",
    message: "Enter your OpenRouter API key (sk-or-v1-...):",
    placeholder: "sk-or-v1-...",
    validate: async (value: string) => {
      if (!value || value.trim().length === 0) {
        return "API key cannot be empty";
      }
      if (!value.startsWith("sk-or-") && !value.startsWith("sk-")) {
        return "Key should start with sk-or- or sk-";
      }
      return null;
    },
  });

  if (key) {
    setApiKey(key.trim());
    await ui.notify({
      message: "API key saved. Vector search enabled.",
      level: "success",
    });
  }
}

/**
 * Handle model selection.
 */
async function handleModelSelection(ui: PiUI): Promise<void> {
  const config = loadEmbeddingConfig();

  const options = OPENROUTER_EMBEDDING_MODELS.map((m) => ({
    label: `${m.name}${m.id === config.model ? " ✓" : ""}`,
    value: m.id,
    description: `${m.description} (${m.dimensions}d, ~${m.costPer1k}/1k tokens)`,
  }));

  // Add custom option
  options.push({
    label: "✏️ Custom Model ID",
    value: "__custom__",
    description: "Enter a custom OpenRouter model ID",
  });

  const selected = await ui.select({
    title: "Select Embedding Model",
    message: "Choose an embedding model. ⚠ Changing model invalidates existing embeddings.",
    options,
  });

  if (!selected) return;

  let modelId = selected;

  if (selected === "__custom__") {
    const custom = await ui.input({
      title: "Custom Model ID",
      message: "Enter the OpenRouter model ID:",
      placeholder: "openai/text-embedding-3-small",
    });
    if (!custom) return;
    modelId = custom.trim();
  }

  // Find model info for dimensions
  const modelInfo = OPENROUTER_EMBEDDING_MODELS.find((m) => m.id === modelId);
  const dimensions = modelInfo?.dimensions ?? 384;

  config.model = modelId;
  config.dimensions = dimensions;
  saveEmbeddingConfig(config);

  await ui.notify({
    message: `Model set to ${modelId} (${dimensions}d).${hasModelChanged() ? " Re-embed existing memories to use new model." : ""}`,
    level: "success",
  });
}

/**
 * Handle dimensions input.
 */
async function handleDimensionsInput(ui: PiUI): Promise<void> {
  const config = loadEmbeddingConfig();

  const dimStr = await ui.input({
    title: "Embedding Dimensions",
    message: `Enter dimensions (default: 384). Lower = faster, less storage.\nNote: openai/text-embedding-3 supports 256-3072.\nada-002 only supports 1536.`,
    placeholder: "384",
    validate: async (value: string) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 64 || num > 3072) {
        return "Must be a number between 64 and 3072";
      }
      return null;
    },
  });

  if (dimStr) {
    const dims = parseInt(dimStr, 10);
    config.dimensions = dims;
    saveEmbeddingConfig(config);

    await ui.notify({
      message: `Dimensions set to ${dims}. Re-embed existing memories to apply.`,
      level: "success",
    });
  }
}

/**
 * Handle re-embedding all memories.
 * This is a destructive operation — warns user first.
 */
async function handleReembed(ui: PiUI, pi: ExtensionAPI): Promise<void> {
  const confirm = await ui.select({
    title: "Re-embed All Memories",
    message: "⚠ This will re-generate ALL embeddings using the current model.\nOld embeddings will be overwritten.\nThis may take a while and costs API calls.",
    options: [
      { label: "Yes, re-embed all", value: "yes", description: "Proceed with re-embedding" },
      { label: "Cancel", value: "no", description: "Abort" },
    ],
  });

  if (confirm !== "yes") return;

  // Import here to avoid circular deps
  const { reembedAllMemories } = await import("../embedding.js");
  const count = await reembedAllMemories(pi);

  markModelUsed();

  await ui.notify({
    message: `Re-embedded ${count} memories with current model.`,
    level: "success",
  });
}
