/**
 * @pi-unipi/utility — Rename session
 *
 * A throwaway in-memory pi session (the /unipi:btw shape) whose ONLY tool is
 * `rename_session`. It never loads extensions, skills or context files, never
 * sees the main transcript, and nothing it does reaches the main session
 * except the name it sets. The main agent never has a rename tool.
 */

import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  SessionManager,
  type ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeName } from "./gate.js";

const SYSTEM_PROMPT = [
  "You name coding-agent sessions so the user can find them later.",
  "Call rename_session exactly once with a short title (2-6 words, Title Case) describing the user's current task.",
  "Name the task, not the conversation: 'Kanboard Lane Ordering', not 'User Asks About Lanes'.",
  "If the current title still describes the current task, call rename_session with the current title unchanged.",
  "Do not write anything else.",
].join("\n");

const RENAME_TIMEOUT_MS = 45_000;

export interface RenameCtx {
  cwd?: string;
  model?: unknown;
  modelRegistry?: unknown;
}

export interface RenameRequest {
  currentName: string | null;
  requests: readonly string[];
  /** "" = session model; otherwise "provider/model-id". */
  model: string;
  /** The gate found the latest request leaves the current title's topic. */
  topicChanged?: boolean;
  /** The agent's reply in the triggering round — often the clearest subject. */
  reply?: string;
}

function resourceLoader(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } as unknown as ResourceLoader;
}

function resolveModel(ref: string, ctx: RenameCtx): unknown {
  const registry = ctx.modelRegistry as { find?: (p: string, id: string) => unknown } | undefined;
  const slash = ref.indexOf("/");
  if (ref && slash > 0 && registry?.find) {
    const found = registry.find(ref.slice(0, slash), ref.slice(slash + 1));
    if (found) return found;
  }
  return ctx.model;
}

export function renamePrompt(req: RenameRequest): string {
  const clip = (r: string) => r.replace(/\s+/g, " ").slice(0, 400);
  if (req.topicChanged && req.currentName) {
    const latest = req.requests.at(-1) ?? "";
    return [
      `Current title: ${req.currentName}`,
      "",
      "The user has moved on to a different task, so the current title no longer fits. Name the NEW task:",
      `- ${clip(latest)}`,
      ...(req.reply ? ["", `What the assistant did about it:\n${clip(req.reply)}`] : []),
    ].join("\n");
  }
  const recent = req.requests.slice(-4).map((r) => `- ${clip(r)}`).join("\n");
  return [
    req.currentName ? `Current title: ${req.currentName}` : "The session has no title yet.",
    "",
    "Recent user requests (oldest first; the last one is the current task):",
    recent || "- (none)",
    ...(req.reply ? ["", `The assistant's latest reply (use it when the request itself is vague):\n${clip(req.reply)}`] : []),
  ].join("\n");
}

/** Run the one-tool session; resolves to the sanitized name it chose, if any.
 *  A configured naming model that fails (removed from the catalog, no key)
 *  falls back once to the session model. */
export async function runRenameSession(
  ctx: RenameCtx,
  req: RenameRequest,
  debug: (line: string) => void = () => {},
): Promise<string | undefined> {
  const runtime = (ctx.modelRegistry as { runtime?: ModelRuntime } | undefined)?.runtime;
  if (!runtime) {
    debug("no model runtime available");
    return undefined;
  }
  const configured = resolveModel(req.model, ctx);
  const candidates = configured && configured !== ctx.model ? [configured, ctx.model] : [ctx.model];
  for (const model of candidates) {
    if (!model) continue;
    const name = await attempt(model, runtime, ctx, req, debug);
    if (name) return name;
  }
  return undefined;
}

async function attempt(
  model: unknown,
  runtime: ModelRuntime,
  ctx: RenameCtx,
  req: RenameRequest,
  debug: (line: string) => void,
): Promise<string | undefined> {
  let chosen: string | undefined;
  const renameTool = defineTool({
    name: "rename_session",
    label: "Rename session",
    description: "Set the session title (2-6 words, Title Case).",
    parameters: Type.Object({ name: Type.String({ description: "The new session title" }) }),
    async execute(_id, params) {
      const name = sanitizeName(String((params as { name?: unknown }).name ?? ""));
      if (!name) return { content: [{ type: "text", text: "Error: empty title." }], details: undefined };
      chosen = name;
      return { content: [{ type: "text", text: `Title set: ${name}` }], details: { name } };
    },
  });

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(ctx.cwd ?? process.cwd()),
    model: model as never,
    modelRuntime: runtime,
    thinkingLevel: "off" as never,
    tools: ["rename_session"],
    customTools: [renameTool as never],
    resourceLoader: resourceLoader(),
  });
  const s = session as unknown as {
    prompt: (m: string, o?: unknown) => Promise<void>;
    abort?: () => Promise<void> | void;
    dispose?: () => void;
    state?: { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string; content?: unknown }> };
  };
  const timer = setTimeout(() => void s.abort?.(), RENAME_TIMEOUT_MS);
  timer.unref?.();
  try {
    await s.prompt(renamePrompt(req), { source: "extension" });
    if (!chosen) {
      const last = (s.state?.messages ?? []).findLast((m) => m.role === "assistant");
      const id = (model as { provider?: string; id?: string });
      debug(`${id.provider}/${id.id}: no rename_session call; stop=${last?.stopReason ?? "?"} ${last?.errorMessage ?? JSON.stringify(last?.content ?? "").slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
    s.dispose?.();
  }
  return chosen;
}
