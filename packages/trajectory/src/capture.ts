import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PrefixIntegrityTracker } from "./prefix-integrity.js";
import { TelemetrySidecar } from "./telemetry.js";
import type { UnipiTraceRecorder } from "./tracer.js";

interface RequestState {
  id: number;
  turnIndex?: number;
  startedAt?: number;
  firstTokenAt?: number;
}

interface PendingAgent {
  runId: number;
}

/** Register read-only observability hooks. Returned reader follows the active session. */
export function registerTelemetryCapture(
  pi: ExtensionAPI,
  sidecarRoot?: string,
  traceRecorder?: UnipiTraceRecorder,
): () => ReturnType<TelemetrySidecar["read"]> {
  let sidecar: TelemetrySidecar | null = null;
  let requestSeq = 0;
  let runSeq = 0;
  let active: RequestState | null = null;
  let lastRequestId: number | null = null;
  let currentTurnIndex: number | undefined;
  let pendingAgent: PendingAgent | null = null;
  let previousTraceCursor = 0;
  const prefixIntegrity = new PrefixIntegrityTracker();
  const toolStarts = new Map<string, number>();

  const bind = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    sidecar = new TelemetrySidecar(sessionId, sidecarRoot);
    traceRecorder?.bind(sessionId);
    const existing = sidecar.read();
    requestSeq = Math.max(0, ...existing.flatMap(event => typeof event.requestId === "number" ? [event.requestId] : []));
    runSeq = Math.max(0, ...existing.flatMap(event => typeof event.runId === "number" ? [event.runId] : []));
    active = null;
    lastRequestId = null;
    currentTurnIndex = undefined;
    pendingAgent = null;
    previousTraceCursor = traceRecorder?.cursor() ?? 0;
    prefixIntegrity.reset();
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

  const ensureRequest = (startedAt?: number) => {
    if (!active) {
      active = { id: ++requestSeq, turnIndex: currentTurnIndex, startedAt };
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


  pi.on("session_start", (_event, ctx) => { bind(ctx); });
  pi.on("resources_discover", () => {});
  pi.on("session_info_changed", () => {});
  pi.on("session_before_switch", () => {});
  pi.on("session_before_fork", () => {});
  pi.on("session_before_compact", () => {});
  pi.on("session_compact", (event) => { prefixIntegrity.markBoundary(`session_compact:${event.reason}`); });
  pi.on("session_before_tree", () => {});
  pi.on("session_tree", () => { prefixIntegrity.markBoundary("session_tree"); });
  pi.on("session_shutdown", () => {});

  pi.on("before_agent_start", (event) => {
    pendingAgent = { runId: ++runSeq };
  });
  pi.on("agent_start", (event, ctx) => {
    active = null;
    lastRequestId = null;
    currentTurnIndex = undefined;
    const runId = pendingAgent?.runId ?? ++runSeq;
    append("system-prompt", {
      systemPrompt: ctx.getSystemPrompt(),
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
    }, { runId });
  });
  pi.on("agent_end", () => {});
  pi.on("agent_settled", () => { pendingAgent = null; });
  pi.on("turn_start", (event) => {
    currentTurnIndex = event.turnIndex;
    active = {
      id: ++requestSeq,
      turnIndex: event.turnIndex,
    };
    lastRequestId = active.id;
  });
  pi.on("turn_end", () => {});

  pi.on("context", () => { ensureRequest(); });
  pi.on("before_provider_headers", () => { ensureRequest(); });
  pi.on("before_provider_request", (event, ctx) => {
    const startedAt = Date.now();
    const request = ensureRequest(startedAt);
    const integrity = prefixIntegrity.observe(event.payload, {
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      api: ctx.model?.api,
      thinkingLevel: ctx.thinkingLevel,
    });
    const traceCursor = traceRecorder?.cursor() ?? 0;
    const contributingTrace = traceRecorder?.since(previousTraceCursor) ?? [];
    previousTraceCursor = traceCursor;
    const attributed = integrity.verdict === "violation"
      ? contributingTrace
          .filter(item => item.type === "unipi-trace")
          .map(item => item.data)
          .filter((data): data is Record<string, unknown> => Boolean(data && typeof data === "object"))
          .filter(data => data.phase === "exit" && (
            data.surface === "hook" && data.mutation && (data.mutation as Record<string, unknown>).changed === true ||
            data.surface === "api" && ["sendMessage", "sendUserMessage", "setActiveTools", "setModel", "setThinkingLevel", "registerProvider", "unregisterProvider"].includes(String(data.action)) ||
            data.surface === "context-api" && ["compact", "navigateTree", "switchSession", "newSession", "fork", "reload"].includes(String(data.action))
          ))
          .slice(-20)
      : [];
    append("prefix-integrity", {
      ...integrity,
      attribution: attributed.length > 0 ? attributed : undefined,
    }, requestExtra(request));
    append("request", {
      payload: event.payload,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
    }, requestExtra(request));
  });
  pi.on("after_provider_response", () => {});

  pi.on("message_start", () => {});
  pi.on("message_update", (event) => {
    const request = ensureRequest();
    if (request.firstTokenAt !== undefined) return;
    if (!["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)) return;
    request.firstTokenAt = Date.now();

  });
  pi.on("message_end", (event) => {
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

  pi.on("tool_execution_start", (event) => { toolStarts.set(event.toolCallId, Date.now()); });
  pi.on("tool_call", () => {});
  pi.on("tool_execution_update", () => {});
  pi.on("tool_result", () => {});
  pi.on("tool_execution_end", (event) => {
    const at = Date.now();
    const startedAt = toolStarts.get(event.toolCallId);
    append("tool-end", {
      toolName: event.toolName,
      isError: event.isError,
      durationMs: startedAt === undefined ? undefined : at - startedAt,
    }, { ...requestExtra(), toolCallId: event.toolCallId });
    toolStarts.delete(event.toolCallId);
  });

  pi.on("model_select", (event) => {
    if (event.previousModel && (
      event.previousModel.provider !== event.model.provider ||
      event.previousModel.id !== event.model.id ||
      event.previousModel.api !== event.model.api
    )) prefixIntegrity.markBoundary("model_select");
  });
  pi.on("thinking_level_select", (event) => {
    if (event.previousLevel !== event.level) prefixIntegrity.markBoundary("thinking_level_select");
  });
  pi.on("user_bash", () => {});
  pi.on("input", () => {});

  return () => sidecar?.read() ?? traceRecorder?.read() ?? [];
}
