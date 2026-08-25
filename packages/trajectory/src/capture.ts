import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TelemetrySidecar } from "./telemetry.js";

interface RequestState {
  id: number;
  startedAt: number;
  firstTokenAt?: number;
}

/** Register read-only observability hooks. Returned reader follows the active session. */
export function registerTelemetryCapture(pi: ExtensionAPI): () => ReturnType<TelemetrySidecar["read"]> {
  let sidecar: TelemetrySidecar | null = null;
  let requestSeq = 0;
  let active: RequestState | null = null;
  const toolStarts = new Map<string, number>();

  const bind = (ctx: ExtensionContext) => {
    sidecar = new TelemetrySidecar(ctx.sessionManager.getSessionId());
    active = null;
    toolStarts.clear();
  };
  const append = (type: Parameters<TelemetrySidecar["append"]>[0]["type"], data?: unknown, extra: Record<string, unknown> = {}) => {
    sidecar?.append({ type, at: Date.now(), ...extra, ...(data === undefined ? {} : { data }) });
  };

  pi.on("session_start", (_event, ctx) => { bind(ctx); });
  pi.on("before_provider_request", (event, ctx) => {
    const startedAt = Date.now();
    active = { id: ++requestSeq, startedAt };
    append("request", {
      payload: event.payload,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinkingLevel: ctx.thinkingLevel,
      tools: Array.isArray((event.payload as { tools?: unknown })?.tools)
        ? (event.payload as { tools: unknown }).tools
        : undefined,
    }, { requestId: active.id });
  });
  pi.on("after_provider_response", (event) => {
    append("response", { status: event.status, headers: event.headers }, active ? { requestId: active.id } : {});
  });
  pi.on("message_update", (event) => {
    if (!active || active.firstTokenAt !== undefined) return;
    if (!["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)) return;
    active.firstTokenAt = Date.now();
    append("first-token", {
      ttftMs: active.firstTokenAt - active.startedAt,
      eventType: event.assistantMessageEvent.type,
    }, { requestId: active.id });
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !active) return;
    const completedAt = Date.now();
    append("message-end", {
      totalMs: completedAt - active.startedAt,
      ttftMs: active.firstTokenAt === undefined ? undefined : active.firstTokenAt - active.startedAt,
      decodingMs: active.firstTokenAt === undefined ? undefined : completedAt - active.firstTokenAt,
      usage: event.message.usage,
      stopReason: event.message.stopReason,
      errorMessage: event.message.errorMessage,
    }, { requestId: active.id });
    active = null;
  });
  pi.on("tool_execution_start", (event) => {
    const at = Date.now();
    toolStarts.set(event.toolCallId, at);
    append("tool-start", { toolName: event.toolName, args: event.args }, { toolCallId: event.toolCallId });
  });
  pi.on("tool_execution_end", (event) => {
    const at = Date.now();
    const startedAt = toolStarts.get(event.toolCallId);
    append("tool-end", {
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
      durationMs: startedAt === undefined ? undefined : at - startedAt,
    }, { toolCallId: event.toolCallId });
    toolStarts.delete(event.toolCallId);
  });

  return () => sidecar?.read() ?? [];
}
