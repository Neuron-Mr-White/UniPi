/**
 * @pi-unipi/utility — image tools: image_generate, image_edit, image_recognize
 *
 * Registered once at load from the enabled flags (static schemas keep the
 * provider prefix cache intact). Failures THROW so pi records them as failed
 * tool results — returning `isError` is ignored by pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IMAGE_TOOLS } from "@pi-unipi/core";
import { loadImage } from "./source.js";
import { recognizeImage } from "./recognize.js";
import { generate, type ImagePayload } from "./transports.js";
import { resolveRoute, resolveVisionModel, type ModelRegistryLike } from "./models.js";
import { getOutputDir, loadConfig, type EndpointSettings } from "./settings.js";

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export function slugify(prompt: string, max = 40): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "") || "image";
}

/** Save images; a failed write never loses the generated image. */
export function saveImages(dir: string, prompt: string, images: ImagePayload[], now = new Date()): string[] {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const saved: string[] = [];
  images.forEach((img, i) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${stamp}-${slugify(prompt)}${i ? `-${i + 1}` : ""}${EXT[img.mimeType] ?? ".png"}`);
      fs.writeFileSync(file, Buffer.from(img.data, "base64"));
      saved.push(file);
    } catch {
      // keep going — the image is still returned inline
    }
  });
  return saved;
}

function registry(ctx: ExtensionContext): ModelRegistryLike | undefined {
  return (ctx as unknown as { modelRegistry?: ModelRegistryLike }).modelRegistry;
}

async function run(
  ctx: ExtensionContext,
  kind: "generate" | "edit",
  prompt: string,
  modelOverride: string | undefined,
  endpoint: EndpointSettings & { model: string },
  source: ImagePayload[] | undefined,
  signal: AbortSignal | undefined,
) {
  const config = loadConfig(ctx.cwd);
  const route = await resolveRoute(modelOverride?.trim() || endpoint.model, modelOverride?.trim() ? { ...endpoint, baseUrl: "" } : endpoint, config, registry(ctx));
  const out = await generate({ ...route, prompt, ...(source ? { images: source } : {}), ...(signal ? { signal } : {}) });
  const saved = config.generate.saveToDisk ? saveImages(getOutputDir(config), prompt, out.images) : [];
  const verb = kind === "edit" ? "Edited" : "Generated";
  const summary = [
    `${verb} ${out.images.length} image${out.images.length === 1 ? "" : "s"} with ${route.label}.`,
    saved.length ? `Saved to:\n${saved.map((p) => `  ${p}`).join("\n")}` : config.generate.saveToDisk ? "Could not save to disk; the image is inline only." : "",
    out.text,
  ].filter(Boolean).join("\n");
  return {
    content: [{ type: "text" as const, text: summary }, ...out.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))],
    details: { model: route.label, count: out.images.length, paths: saved },
  };
}

export function registerImageTools(pi: ExtensionAPI): void {
  const config = loadConfig();

  if (config.generate.enabled) {
    pi.registerTool({
      name: IMAGE_TOOLS.GENERATE,
      label: "Generate Image",
      description: "Generate an image from a text prompt. Returned inline and saved to disk.",
      promptSnippet: "Generate an image from a text prompt.",
      promptGuidelines: [
        "Write a detailed prompt — subject, style, composition and lighting all help.",
        "Describe what you DO want; negation is unreliable in image models.",
        "To change an existing image use image_edit instead.",
        "Omit model to use the one configured in /unipi:settings. Images cost money; do not regenerate unasked.",
      ],
      parameters: Type.Object({
        prompt: Type.String({ description: "Description of the image. Be specific." }),
        model: Type.Optional(Type.String({ description: 'Override as "provider/model-id", e.g. "openrouter/black-forest-labs/flux.2-klein-4b" or "fal/fal-ai/flux-2/klein/4b".' })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const c = loadConfig(ctx.cwd);
        return run(ctx, "generate", params.prompt, params.model, c.generate, undefined, signal);
      },
    });
  }

  if (config.edit.enabled) {
    pi.registerTool({
      name: IMAGE_TOOLS.EDIT,
      label: "Edit Image",
      description: "Edit an existing image with a text instruction. Returned inline and saved to disk.",
      promptSnippet: "Edit an existing image with a text instruction.",
      promptGuidelines: [
        "Pass the source image as a file path (preferred), data: URL or base64.",
        "Say what to change and what to keep; unmentioned details may change.",
      ],
      parameters: Type.Object({
        prompt: Type.String({ description: "What to change." }),
        image: Type.String({ description: "Source image: local file path, data: URL, or base64." }),
        model: Type.Optional(Type.String({ description: 'Override as "provider/model-id" (must accept an image and output one).' })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const c = loadConfig(ctx.cwd);
        const src = loadImage(params.image, ctx.cwd ?? process.cwd());
        return run(ctx, "edit", params.prompt, params.model, c.edit, [{ data: src.data, mimeType: src.mimeType }], signal);
      },
    });
  }

  if (config.recognize.enabled) {
    pi.registerTool({
      name: IMAGE_TOOLS.RECOGNIZE,
      label: "Recognize Image",
      description: "Analyze an image and answer questions about it using a vision model.",
      promptSnippet: "Analyze an image and answer questions about it.",
      promptGuidelines: [
        "Use image_recognize to read screenshots, diagrams, mockups and photos.",
        "Pass a local file path when possible — cheaper than inlining base64.",
        "Ask a specific question in `prompt` to focus the analysis.",
      ],
      parameters: Type.Object({
        image: Type.String({ description: "Local file path, data: URL, or base64 (PNG, JPEG, GIF, WebP)." }),
        prompt: Type.Optional(Type.String({ description: "What to ask about the image. Defaults to a general description." })),
        model: Type.Optional(Type.String({ description: "Vision model override (must accept image input)." })),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        const c = loadConfig(ctx.cwd).recognize;
        const image = loadImage(params.image, ctx.cwd ?? process.cwd());
        const prompt = params.prompt?.trim() || "Describe this image in detail.";
        let target: { baseUrl: string; apiKey: string; api: string; modelId: string; label: string };
        const requested = params.model?.trim() || c.model.trim();
        if (c.baseUrl.trim() && !params.model?.trim()) {
          if (!requested) throw new Error("Set a model id for the custom recognition endpoint in /unipi:settings → Image.");
          target = { baseUrl: c.baseUrl.trim(), apiKey: c.apiKey, api: "openai-completions", modelId: requested, label: `${requested} @ ${c.baseUrl.trim()}` };
        } else {
          const reg = registry(ctx);
          if (!reg) throw new Error("Model registry unavailable — image_recognize needs an active session.");
          const session = (ctx as unknown as { model?: { provider?: string; id?: string } }).model;
          const ref = requested || (session?.provider && session.id ? `${session.provider}/${session.id}` : "");
          if (!ref) throw new Error("No vision model configured — choose one in /unipi:settings → Image.");
          const model = resolveVisionModel(ref, reg);
          if (typeof model === "string") throw new Error(model);
          const full = reg.find(model.provider, model.id) as { baseUrl?: string; api?: string } | undefined;
          if (!full?.baseUrl) throw new Error(`No endpoint known for ${model.provider}/${model.id}.`);
          const apiKey = (await reg.getApiKeyForProvider?.(model.provider).catch(() => undefined)) ?? "";
          if (!apiKey) throw new Error(`No key for provider "${model.provider}". Log in with /login.`);
          target = { baseUrl: full.baseUrl, apiKey, api: full.api ?? "openai-completions", modelId: model.id, label: `${model.provider}/${model.id}` };
        }
        const result = await recognizeImage({ image, prompt, systemPrompt: c.systemPrompt, apiKey: target.apiKey, baseUrl: target.baseUrl, api: target.api, modelId: target.modelId, ...(signal ? { signal } : {}) });
        return {
          content: [{ type: "text" as const, text: `${result.text}\n\n— analyzed with ${target.label}${image.path ? ` (${image.path})` : ""}` }],
          details: { model: target.label, mimeType: image.mimeType, ...(image.path ? { path: image.path } : {}) },
        };
      },
    });
  }
}
