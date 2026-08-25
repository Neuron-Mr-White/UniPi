import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TelemetrySidecar } from "./telemetry.js";

interface RequestState {
  id: number;
  turnIndex?: number;
  startedAt?: number;
  firstTokenAt?: number;
  streamChunk: unknown[];
  streamChunkIndex: number;
}

interface PendingAgent {
  runId: number;
  prompt: string;
  images?: unknown;
  observedSystemPrompt: string;
  systemPromptOptions: unknown;
}

/** Register read-only observability hooks. Returned reader follows the active session. */
export function registerTelemetryCapture(
  pi: ExtensionAPI,
  sidecarRoot?: string,
): () => ReturnType<TelemetrySidecar["read"]> {
  let sidecar: TelemetrySidecar | null = null;
  let requestSeq = 0;
  let runSeq = 0;
  let active: RequestState | null = null;
  let lastRequestId: number | null = null;
  let currentTurnIndex: number | undefined;
  let pendingAgent: PendingAgent | null = null;
  const toolStarts = new Map<string, number>();

  const bind = (ctx: ExtensionContext) => {
    sidecar = new TelemetrySidecar(ctx.sessionManager.getSessionId(), sidecarRoot);
    const existing = sidecar.read();
    requestSeq = Math.max(0, ...existing.flatMap(event => typeof event.requestId === "number" ? [event.requestId] : []));
    runSeq = Math.max(0, ...existing.flatMap(event => typeof event.runId === "number" ? [event.runId] : []));
    active = null;
    lastRequestId = null;
    currentTurnIndex = undefined;
    pendingAgent = null;
    toolStarts.clear();
  };
  const append = (
    type: Parameters<TelemetrySidecar["append"]>[0]["type"],
    data?: unknown,
    extra: Record<string, unknown> = {},
    at = Date.now(),
  ) => {
    sidecar?.append({ type, at, ...extra, ...(data === undefined ? {} : { data }) });
  };
  const payload = (event: { type: string }) => {
    const { type: _type, ...rest } = event as { type: string } & Record<string, unknown>;
    return rest;
  };
  const hook = (name: string, event?: object, extra: Record<string, unknown> = {}) => {
    append("hook", { name, payload: event ? payload(event as { type: string }) : {} }, extra);
  };
  const ensureRequest = (startedAt?: number) => {
    if (!active) {
      active = { id: ++requestSeq, turnIndex: currentTurnIndex, startedAt, streamChunk: [], streamChunkIndex: 0 };
    } else if (startedAt !== undefined) {
      active.startedAt = startedAt;
    }
    lastRequestId = active.id;
    return active;
  };
  const requestExtra = (request = active) => ({
    ...(request?.id !== undefined ? { requestId: request.id } : lastRequestId === null ? {} : { requestId: lastRequestId }),
    ...(request?.turnIndex !== undefined ? { turnIndex: request.turnIndex } : currentTurnIndex === undefined ? {} : { turnIndex: currentTurnIndex }),
  });
  const flushStream = () => {
    if (!active?.streamChunk.length) return;
    append("hook", {
      name: "message_update",
      payload: { chunk: active.streamChunkIndex++, events: active.streamChunk.splice(0) },
    }, requestExtra());
  };

  pi.on("session_start", (event, ctx) => {
    bind(ctx);
    hook(event.type, event);
  });
  pi.on("resources_discover", (event) => { hook(event.type, event); });
  pi.on("session_info_changed", (event) => { hook(event.type, event); });
  pi.on("session_before_switch", (event) => { hook(event.type, event); });
  pi.on("session_before_fork", (event) => { hook(event.type, event); });
  pi.on("session_before_compact", (event) => {
    hook(event.type, {
      ...event,
      preparation: {
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
      branchEntries: {
        count: event.branchEntries.length,
        firstId: event.branchEntries[0]?.id,
        lastId: event.branchEntries.at(-1)?.id,
      },
      signal: { aborted: event.signal.aborted },
    });
  });
  pi.on("session_compact", (event) => { hook(event.type, event); });
  pi.on("session_before_tree", (event) => {
    hook(event.type, {
      ...event,
      preparation: {
        ...event.preparation,
        entriesToSummarize: {
          count: event.preparation.entriesToSummarize.length,
          firstId: event.preparation.entriesToSummarize[0]?.id,
          lastId: event.preparation.entriesToSummarize.at(-1)?.id,
        },
      },
      signal: { aborted: event.signal.aborted },
    });
  });
  pi.on("session_tree", (event) => { hook(event.type, event); });
  pi.on("session_shutdown", (event) => { hook(event.type, event); });

  pi.on("before_agent_start", (event) => {
    pendingAgent = {
      runId: ++runSeq,
      prompt: event.prompt,
      images: event.images,
      observedSystemPrompt: event.systemPrompt,
      systemPromptOptions: {
        ...event.systemPromptOptions,
        skills: event.systemPromptOptions.skills?.map(skill => ({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          disableModelInvocation: skill.disableModelInvocation,
        })),
      },
    };
    hook(event.type, event, { runId: pendingAgent.runId });
  });
  pi.on("agent_start", (event, ctx) => {
    active = null;
    lastRequestId = null;
    currentTurnIndex = undefined;
    const runId = pendingAgent?.runId ?? ++runSeq;
    append("system-prompt", {
      prompt: pendingAgent?.prompt,
      images: pendingAgent?.images,
      systemPrompt: ctx.getSystemPrompt(),
      observedSystemPrompt: pendingAgent?.observedSystemPrompt,
      systemPromptOptions: pendingAgent?.systemPromptOptions,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
    }, { runId });
    hook(event.type, event, { runId });
  });
  pi.on("agent_end", (event) => {
    flushStream();
    hook(event.type, { type: event.type, messageCount: event.messages.length }, pendingAgent ? { runId: pendingAgent.runId } : {});
  });
  pi.on("agent_settled", (event) => {
    hook(event.type, event, pendingAgent ? { runId: pendingAgent.runId } : {});
    pendingAgent = null;
  });
  pi.on("turn_start", (event) => {
    currentTurnIndex = event.turnIndex;
    active = {
      id: ++requestSeq,
      turnIndex: event.turnIndex,
      streamChunk: [],
      streamChunkIndex: 0,
    };
    lastRequestId = active.id;
    append("hook", { name: event.type, payload: payload(event) }, requestExtra(), event.timestamp);
  });
  pi.on("turn_end", (event) => {
    hook(event.type, {
      type: event.type,
      turnIndex: event.turnIndex,
      message: event.message,
      toolResults: event.toolResults.map(result => ({
        role: result.role,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        isError: result.isError,
      })),
    }, { ...requestExtra(), turnIndex: event.turnIndex });
  });

  pi.on("context", (event) => {
    const request = ensureRequest();
    hook(event.type, event, requestExtra(request));
  });
  pi.on("before_provider_headers", (event) => {
    const request = ensureRequest();
    hook(event.type, event, requestExtra(request));
  });
  pi.on("before_provider_request", (event, ctx) => {
    const startedAt = Date.now();
    const request = ensureRequest(startedAt);
    append("request", {
      payload: event.payload,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
      tools: Array.isArray((event.payload as { tools?: unknown })?.tools)
        ? (event.payload as { tools: unknown }).tools
        : undefined,
    }, requestExtra(request));
  });
  pi.on("after_provider_response", (event) => {
    append("response", { status: event.status, headers: event.headers }, requestExtra());
  });

  pi.on("message_start", (event) => {
    hook(event.type, event, requestExtra());
  });
  pi.on("message_update", (event) => {
    const request = ensureRequest();
    const streamEvent = event.assistantMessageEvent;
    // `partial` repeats the whole response-so-far on every token. Persisting it
    // would make one response quadratic; deltas + terminal content are complete.
    const { partial: _partial, ...streamData } = streamEvent as typeof streamEvent & { partial?: unknown };
    request.streamChunk.push(streamData);
    if (request.streamChunk.length >= 50) flushStream();
    if (request.firstTokenAt !== undefined) return;
    if (!["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)) return;
    request.firstTokenAt = Date.now();
    append("first-token", {
      ttftMs: request.startedAt === undefined ? undefined : request.firstTokenAt - request.startedAt,
      eventType: event.assistantMessageEvent.type,
    }, requestExtra(request));
  });
  pi.on("message_end", (event) => {
    flushStream();
    hook(event.type, event, requestExtra());
    if (event.message.role !== "assistant" || !active) return;
    const completedAt = Date.now();
    append("message-end", {
      totalMs: active.startedAt === undefined ? undefined : completedAt - active.startedAt,
      ttftMs: active.startedAt === undefined || active.firstTokenAt === undefined
        ? undefined
        : active.firstTokenAt - active.startedAt,
      decodingMs: active.firstTokenAt === undefined ? undefined : completedAt - active.firstTokenAt,
      usage: event.message.usage,
      stopReason: event.message.stopReason,
      errorMessage: event.message.errorMessage,
    }, requestExtra());
    active = null;
  });

  pi.on("tool_execution_start", (event) => {
    const at = Date.now();
    toolStarts.set(event.toolCallId, at);
    append("tool-start", { toolName: event.toolName, args: event.args }, { ...requestExtra(), toolCallId: event.toolCallId });
  });
  pi.on("tool_call", (event) => {
    hook(event.type, event, { ...requestExtra(), toolCallId: event.toolCallId });
  });
  pi.on("tool_execution_update", (event) => {
    hook(event.type, event, { ...requestExtra(), toolCallId: event.toolCallId });
  });
  pi.on("tool_result", (event) => {
    hook(event.type, event, { ...requestExtra(), toolCallId: event.toolCallId });
  });
  pi.on("tool_execution_end", (event) => {
    const at = Date.now();
    const startedAt = toolStarts.get(event.toolCallId);
    append("tool-end", {
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
      durationMs: startedAt === undefined ? undefined : at - startedAt,
    }, { ...requestExtra(), toolCallId: event.toolCallId });
    toolStarts.delete(event.toolCallId);
  });

  pi.on("model_select", (event) => { hook(event.type, event); });
  pi.on("thinking_level_select", (event) => { hook(event.type, event); });
  pi.on("user_bash", (event) => { hook(event.type, event); });
  pi.on("input", (event) => { hook(event.type, event); });

  return () => sidecar?.read() ?? [];
}
