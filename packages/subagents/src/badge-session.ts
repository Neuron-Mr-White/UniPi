/**
 * One-shot in-memory session for badge naming — same shape as btw's
 * runQuestion: SessionManager.inMemory + createAgentSession, no tools, one
 * prompt, parent modelRuntime. Returns the assistant's text.
 */

import { SessionManager, createAgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveModel } from "./model-resolver.js";

export interface BadgeCtx {
  model?: unknown;
  modelRegistry?: { runtime?: ModelRuntime; getAvailable?: () => unknown[]; getAll?: () => unknown[] } | unknown;
  cwd?: string;
  thinkingLevel?: string;
}

export async function createInMemoryBadgeSession(
  ctx: BadgeCtx,
  prompt: string,
  modelInput: string | undefined,
): Promise<string | undefined> {
  const registry = ctx.modelRegistry as Parameters<typeof resolveModel>[1] | undefined;
  const model = modelInput !== undefined && registry !== undefined
    ? (() => {
        const r = resolveModel(modelInput, registry);
        return typeof r === "string" ? ctx.model : r;
      })()
    : ctx.model;
  const runtime = (ctx.modelRegistry as { runtime?: ModelRuntime } | undefined)?.runtime;
  if (model === undefined || runtime === undefined) return undefined;
  const seeded = await createAgentSession({
    sessionManager: SessionManager.inMemory(ctx.cwd ?? process.cwd()),
    model: model as never,
    modelRuntime: runtime,
    thinkingLevel: (ctx.thinkingLevel ?? "medium") as never,
    tools: [],
  });
  const session = seeded.session as { prompt: (m: string, o?: unknown) => Promise<void>; getLastAssistantText?: () => string | undefined; dispose?: () => void };
  try {
    await session.prompt(prompt, { source: "extension" });
    const text = typeof session.getLastAssistantText === "function" ? session.getLastAssistantText() : undefined;
    return typeof text === "string" ? text.trim() : undefined;
  } finally {
    session.dispose?.();
  }
}
