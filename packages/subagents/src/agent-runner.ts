/**
 * @pi-unipi/subagents — Agent runner
 *
 * Creates sessions, runs agents, collects results.
 * Forwards abort signals for ESC propagation.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentType, ThinkingLevel } from "./types.js";

/** Tools excluded from subagents to prevent nesting. */
const EXCLUDED_TOOL_NAMES = ["Agent", "get_result"];

/** All known built-in tool names. */
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Default max turns. undefined = unlimited. */
let defaultMaxTurns: number | undefined;

export function getDefaultMaxTurns(): number | undefined {
  return defaultMaxTurns;
}

export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = n == null || n === 0 ? undefined : Math.max(1, n);
}

/** Grace turns after soft limit. */
let graceTurns = 5;

export function getGraceTurns(): number {
  return graceTurns;
}

export function setGraceTurns(n: number): void {
  graceTurns = Math.max(1, n);
}

/** Tool activity info. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

/** Options for running an agent. */
export interface RunOptions {
  pi: ExtensionAPI;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  cwd?: string;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
}

/** Result from running an agent. */
export interface RunResult {
  responseText: string;
  session: AgentSession;
  aborted: boolean;
  steered: boolean;
}

/** Collect last assistant message text. */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get last assistant text from session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Wire abort signal to session. */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Get tool names for agent type. */
function getToolNamesForType(type: AgentType, config?: AgentConfig): string[] {
  if (config?.builtinToolNames?.length) {
    return [...config.builtinToolNames];
  }
  return [...BUILTIN_TOOL_NAMES];
}

/** Resolve model from config. */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  configModel?: string,
): Model<any> | undefined {
  // For now, just use parent model. Full model resolution requires registry.
  return parentModel;
}

/**
 * Run an agent session.
 */
export async function runAgent(
  ctx: ExtensionContext,
  type: AgentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const effectiveCwd = options.cwd ?? ctx.cwd;

  // Build system prompt
  const agentConfig = options as any; // Will be properly typed later
  const parentSystemPrompt = ctx.getSystemPrompt();

  let systemPrompt: string;
  if (options.isolated) {
    systemPrompt = `You are a ${type} agent. Follow the task instructions precisely. Do not ask questions.`;
  } else {
    systemPrompt = parentSystemPrompt + `\n\nYou are a ${type} agent. Follow the task instructions precisely.`;
  }

  // Get tool names
  let toolNames = getToolNamesForType(type);

  // Create resource loader
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: options.isolated,
    noSkills: options.isolated,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Resolve model
  const model = options.model ?? resolveDefaultModel(ctx.model);

  // Create session
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(effectiveCwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model,
    tools: toolNames,
    resourceLoader: loader,
  };
  if (options.thinkingLevel) {
    sessionOpts.thinkingLevel = options.thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  // Filter out our tools to prevent nesting
  const activeTools = session.getActiveToolNames().filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    return true;
  });
  session.setActiveToolsByName(activeTools);

  // Bind extensions
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  // Track turns
  let turnCount = 0;
  const maxTurns = options.maxTurns ?? defaultMaxTurns;
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  try {
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: softLimitReached };
}

/**
 * Get conversation text from a session.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const content = msg.content;
      const text = typeof content === "string"
        ? content
        : content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      const content = msg.content;
      if (typeof content !== "string") {
        for (const c of content) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? "unknown"}`);
        }
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const content = msg.content;
      const text = typeof content === "string"
        ? content
        : content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("");
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
