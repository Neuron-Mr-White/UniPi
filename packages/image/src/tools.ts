/**
 * @pi-unipi/image — Agent tool registration
 *
 * Registers `image_generate` and `image_recognize`. Each tool is registered
 * only when enabled in config, so a user who wants just one does not have the
 * other consuming context in the system prompt.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IMAGE_TOOLS } from "@pi-unipi/core";

import { generateImage } from "./generate.js";
import { loadImage } from "./image-source.js";
import {
  formatModelRef,
  listAllImageGenModels,
  resolveImageGenModel,
  resolveVisionModel,
  splitModelRef,
  type ChatModelRegistry,
  type VisionModel,
} from "./models.js";
import { recognizeImage } from "./recognize.js";
import { getOutputDir, loadConfig } from "./settings.js";

/** Error shape shared by both tools. */
function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details: {},
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the chat model registry off the extension context. */
function getRegistry(ctx: ExtensionContext): ChatModelRegistry | undefined {
  return (ctx as unknown as { modelRegistry?: ChatModelRegistry }).modelRegistry;
}

/** Resolve an API key for a provider through pi's auth storage. */
async function resolveApiKey(
  registry: ChatModelRegistry | undefined,
  provider: string,
): Promise<string | undefined> {
  try {
    const key = await registry?.getApiKeyForProvider?.(provider);
    if (key) return key;
  } catch {
    // Fall through to the environment.
  }

  const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[envName] || undefined;
}

/** Look up the full pi-ai model object for a vision model. */
function findChatModel(
  registry: ChatModelRegistry,
  model: VisionModel,
): { baseUrl?: string; api?: string } | undefined {
  try {
    return registry.find(model.provider, model.id) as
      | { baseUrl?: string; api?: string }
      | undefined;
  } catch {
    return undefined;
  }
}

export function registerImageTools(pi: ExtensionAPI): void {
  const config = loadConfig();

  if (config.generate.enabled) registerGenerateTool(pi);
  if (config.recognize.enabled) registerRecognizeTool(pi);
}

function registerGenerateTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: IMAGE_TOOLS.GENERATE,
    label: "Generate Image",
    description:
      "Generate an image from a text prompt using an image model. " +
      "The image is returned inline and, when enabled, saved to disk.",
    promptSnippet: "Generate an image from a text prompt.",
    promptGuidelines: [
      "Use image_generate to create images from a text description.",
      "Write a detailed prompt — subject, style, composition and lighting all help.",
      "Omit model to use the one configured in /unipi:image-settings.",
      "Generated images cost money per call; do not regenerate without being asked.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "Description of the image to generate. Be specific.",
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Image model override, e.g. "flux.2-pro" or ' +
            '"openrouter/google/gemini-3-pro-image". Omit to use the configured default.',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const config = loadConfig();
        const registry = getRegistry(ctx);
        // Include image models contributed by registered providers, so the
        // tool can resolve anything the settings picker offers.
        const models = await listAllImageGenModels(registry);

        const requested = params.model?.trim() || config.generate.model;
        const resolved = resolveImageGenModel(requested, models);
        if (typeof resolved === "string") return errorResult(resolved);

        // pi-ai resolves image auth from its own credential store; only fall
        // back to pi's chat-provider key when that comes up empty.
        const fallbackKey = await resolveApiKey(registry, resolved.provider);

        const result = await generateImage({
          prompt: params.prompt,
          model: resolved,
          ...(fallbackKey ? { apiKey: fallbackKey } : {}),
          signal,
          outputDir: config.generate.saveToDisk ? getOutputDir(config) : undefined,
        });

        const saved = result.images
          .map((image) => image.path)
          .filter((path): path is string => Boolean(path));

        const summary = [
          `Generated ${result.images.length} image${result.images.length === 1 ? "" : "s"} ` +
            `with ${formatModelRef(resolved)}.`,
          saved.length > 0 ? `Saved to:\n${saved.map((p) => `  ${p}`).join("\n")}` : "",
          config.generate.saveToDisk && saved.length === 0
            ? "Could not write to the output directory — returning the image inline only."
            : "",
          result.text,
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [
            { type: "text" as const, text: summary },
            ...result.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
          details: {
            model: formatModelRef(resolved),
            count: result.images.length,
            paths: saved,
          },
        };
      } catch (error) {
        return errorResult(`Image generation failed: ${messageOf(error)}`);
      }
    },
  });
}

function registerRecognizeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: IMAGE_TOOLS.RECOGNIZE,
    label: "Recognize Image",
    description:
      "Analyze an image and answer questions about it using a vision model. " +
      "Accepts a local file path, a data: URL, or base64 image data.",
    promptSnippet: "Analyze an image and answer questions about it.",
    promptGuidelines: [
      "Use image_recognize to read screenshots, diagrams, mockups and photos.",
      "Pass a local file path whenever possible — it is cheaper than inlining base64.",
      "Ask a specific question in `prompt` to focus the analysis.",
      "Remote URLs are not fetched; download the image first.",
    ],
    parameters: Type.Object({
      image: Type.String({
        description:
          "Local file path, data: URL, or base64 image data. " +
          "Supported types: PNG, JPEG, GIF, WebP.",
      }),
      prompt: Type.Optional(
        Type.String({
          description:
            "What to ask about the image. Defaults to a general description.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Vision model override. Must accept image input. " +
            "Omit to use the configured default or the current session model.",
        }),
      ),
      systemPrompt: Type.Optional(
        Type.String({
          description:
            "Override the configured system prompt for this call only.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const config = loadConfig();

        const registry = getRegistry(ctx);
        if (!registry) {
          return errorResult(
            "Model registry unavailable — image_recognize needs an active session.",
          );
        }

        // Precedence: per-call override, configured model, session model.
        const requested =
          params.model?.trim() ||
          config.recognize.model.trim() ||
          currentSessionModel(ctx);

        if (!requested) {
          return errorResult(
            "No vision model configured.\n" +
              "→ Choose one with /unipi:image-settings, or pass `model`.",
          );
        }

        const resolved = resolveVisionModel(requested, registry);
        if (typeof resolved === "string") return errorResult(resolved);

        const image = loadImage(params.image, ctx.cwd ?? process.cwd());

        const chatModel = findChatModel(registry, resolved);
        const baseUrl = chatModel?.baseUrl;
        if (!baseUrl) {
          return errorResult(
            `Could not determine the API endpoint for ${formatModelRef(resolved)}.`,
          );
        }

        const apiKey = await resolveApiKey(registry, resolved.provider);
        if (!apiKey) {
          return errorResult(
            `No API key for provider "${resolved.provider}".\n` +
              "→ Sign in with /login, or set the provider's API key environment variable.",
          );
        }

        const result = await recognizeImage({
          image,
          prompt: params.prompt?.trim() || "Describe this image in detail.",
          systemPrompt: params.systemPrompt?.trim() || config.recognize.systemPrompt,
          apiKey,
          baseUrl,
          api: chatModel?.api ?? "openai-completions",
          modelId: resolved.id,
          signal,
        });

        const origin = image.path ? ` (${image.path})` : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `${result.text}\n\n— analyzed with ${formatModelRef(resolved)}${origin}`,
            },
          ],
          details: {
            model: formatModelRef(resolved),
            mimeType: image.mimeType,
            source: image.source,
            ...(image.path ? { path: image.path } : {}),
          },
        };
      } catch (error) {
        return errorResult(`Image recognition failed: ${messageOf(error)}`);
      }
    },
  });
}

/** The session's current model as "provider/id", when discoverable. */
function currentSessionModel(ctx: ExtensionContext): string {
  const model = (ctx as unknown as { model?: { provider?: string; id?: string } }).model;
  if (model?.provider && model?.id) {
    return formatModelRef({ provider: model.provider, id: model.id });
  }
  return "";
}

export { splitModelRef };
