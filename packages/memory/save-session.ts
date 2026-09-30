/**
 * @unipi/memory — background save session (saveMode "side")
 *
 * On agent_end a one-shot AgentSession is seeded from the main session's
 * current branch (SessionManager.inMemory — the same path /unipi:btw uses)
 * and asked to store anything durable. Nothing reaches the main context:
 * no sendMessage, only a UI-only appendEntry card when something was stored.
 *
 * Prefix-cache parity is the point: same model, same thinking level, the
 * verbatim system prompt (ctx.getSystemPrompt(), no appends, no stripping),
 * and the same tool list — every ACTIVE tool is re-exposed as a customTools
 * stub carrying the identical name/description/parameters from
 * pi.getAllTools(). Non-memory stubs refuse; the memory tools call the real
 * executors from tools.ts.
 */

import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type FileEntry,
  type ModelRuntime,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionBackend } from "./session.js";
import { MEMORY_TOOLS, memoryExecutors } from "./tools.js";

export const SAVE_CARD_TYPE = "unipi-memory-save-card";
export const SAVE_PROMPT =
  "Memory save pass. Review the task that just finished in this conversation. " +
  "If you learned something non-obvious and durable (decision, pitfall + fix, project pattern, user preference), " +
  "call memory_search to check for an existing memory, then memory_store (update rather than duplicate). " +
  "If nothing qualifies, reply exactly NONE. Do not call any other tool.";

const MAX_SAVE_TOOL_CALLS = 8;

export interface SaveUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface MemorySaveOutcome {
  /** Titles stored or updated during the pass. */
  stored: string[];
  /** Summed usage across the side session's assistant messages. */
  usage?: SaveUsage;
  error?: string;
}

export interface MemorySaveRun {
  abort(): void;
  finished: Promise<MemorySaveOutcome>;
}

/** Whether a finished main-session run qualifies for the background save pass. */
export function shouldRunSideSave(input: {
  write: boolean;
  writeOverride?: boolean;
  hooksEnabled: boolean;
  storeActive: boolean;
  /** Tool calls in the run that just ended (all tools). */
  runToolCalls: number;
  /** Any edit/write in the run that just ended. */
  runHadWrite: boolean;
  /** The main agent stored/deleted a memory itself during the run. */
  runStoredMemory: boolean;
  /** A save session is already in flight. */
  running: boolean;
}): boolean {
  if (!input.write || input.writeOverride === false) return false;
  if (!input.hooksEnabled) return false;
  if (!input.storeActive) return false;
  if (input.runStoredMemory) return false;
  if (input.runToolCalls < 3 && !input.runHadWrite) return false;
  if (input.running) return false; // one at a time — skip, never queue
  return true;
}

/** Tool names that reach the real implementations inside the save session.
 *  memory_delete stays a stub: a background pass may add knowledge, never
 *  remove it. */
const REAL_MEMORY_EXECUTES = new Set<string>([
  MEMORY_TOOLS.STORE,
  MEMORY_TOOLS.SEARCH,
  MEMORY_TOOLS.LIST,
  MEMORY_TOOLS.GLOBAL_SEARCH,
  MEMORY_TOOLS.GLOBAL_LIST,
]);

const STUB_REFUSAL = "Not available in the memory save session.";

/**
 * customTools mirroring the main session's active tools: identical names,
 * descriptions and parameter schemas so the serialized request prefix matches
 * what the main agent just sent. Order follows pi.getAllTools() (builtins keep
 * their positions — a same-named customTool overrides in place).
 */
export function buildSaveTools(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
  backend: () => SessionBackend | null,
  onStored?: (title: string) => void,
): ToolDefinition[] {
  const active = new Set(pi.getActiveTools());
  const ex = memoryExecutors(pi as never, backend);
  const real = (name: string) => {
    switch (name) {
      case MEMORY_TOOLS.STORE:
        return async (_id: string, params: { title: string; content: string; tags?: string[]; type?: string }, _s: unknown, _o: unknown, ctx: { cwd: string }) => {
          const res = await ex.store(params, ctx);
          const action = (res.details as { action?: string } | undefined)?.action;
          if (action === "created" || action === "updated") onStored?.(params.title);
          return res;
        };
      case MEMORY_TOOLS.SEARCH:
        return async (_id: string, params: { query: string; limit?: number; scope?: string }) => ex.search(params);
      case MEMORY_TOOLS.GLOBAL_SEARCH:
        return async (_id: string, params: { query: string; limit?: number }) =>
          ex.search({ query: params.query, limit: params.limit, scope: "all" });
      case MEMORY_TOOLS.LIST:
        return async () => ex.list();
      case MEMORY_TOOLS.GLOBAL_LIST:
        return async () => ex.globalList();
      default:
        return undefined;
    }
  };
  return pi
    .getAllTools()
    .filter((info) => active.has(info.name))
    .map(
      (info): ToolDefinition => ({
        name: info.name,
        label: info.name,
        description: info.description,
        promptGuidelines: info.promptGuidelines,
        parameters: info.parameters,
        execute:
          real(info.name) ??
          (async () => ({
            content: [{ type: "text" as const, text: STUB_REFUSAL }],
            details: {},
          })),
      }),
    );
}

/** Header + current branch, verbatim — the seeded side session sees exactly
 *  the context the main agent just worked in (max prefix overlap). */
export function buildSeedEntries(ctx: {
  sessionManager: {
    getHeader(): { type: string } | null;
    getBranch(): Array<{ type: string; customType?: string }>;
  };
}): FileEntry[] {
  const header = ctx.sessionManager.getHeader();
  const branch = ctx.sessionManager.getBranch();
  return header
    ? [header as FileEntry, ...(branch as FileEntry[])]
    : (branch as FileEntry[]);
}

/** Identical system prompt to the main session — no append, no stripping. */
function createSaveResourceLoader(ctx: ExtensionContext): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = ctx.getSystemPrompt();
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function sumUsage(session: AgentSession): SaveUsage | undefined {
  let usage: SaveUsage | undefined;
  for (const message of session.state.messages) {
    if (message.role !== "assistant") continue;
    const u = (message as AssistantMessage).usage;
    if (!u) continue;
    usage ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    usage.input += u.input;
    usage.cacheRead += u.cacheRead;
    usage.cacheWrite += u.cacheWrite;
    usage.output += u.output;
  }
  return usage;
}

/**
 * Start the background save pass. Caller owns gating (shouldRunSideSave) and
 * the one-at-a-time check — this just runs.
 */
export function startMemorySave(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  backend: () => SessionBackend | null,
): MemorySaveRun {
  let session: AgentSession | null = null;
  const stored: string[] = [];

  const finished = (async (): Promise<MemorySaveOutcome> => {
    const model = ctx.model;
    if (!model) return { stored, error: "no active model" };
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return { stored, error: auth.ok ? "no credentials" : (auth.error ?? "no credentials") };
    }
    try {
      const seeded = await createAgentSession({
        sessionManager: SessionManager.inMemory(ctx.cwd, undefined, buildSeedEntries(ctx)),
        model,
        modelRuntime: (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime,
        thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
        customTools: buildSaveTools(pi, backend, (title) => stored.push(title)),
        tools: pi.getActiveTools(),
        resourceLoader: createSaveResourceLoader(ctx),
      });
      session = seeded.session;
      let toolCalls = 0;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          toolCalls += 1;
          if (toolCalls >= MAX_SAVE_TOOL_CALLS) void session?.abort().catch(() => {});
        }
      });
      try {
        await session.prompt(SAVE_PROMPT, { source: "extension" });
      } finally {
        unsubscribe();
      }
      return { stored, usage: sumUsage(session) };
    } catch (error) {
      return { stored, error: error instanceof Error ? error.message : String(error) };
    } finally {
      try {
        session?.dispose();
      } catch {
        /* already disposed */
      }
      session = null;
    }
  })();

  return {
    abort() {
      void session?.abort().catch(() => {});
    },
    finished,
  };
}
