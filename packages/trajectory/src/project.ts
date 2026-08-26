import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TelemetryEvent } from "./telemetry.js";

export type TrajectoryKind = "system" | "unipi" | "prefix" | "user" | "assistant" | "tool" | "compaction" | "branch";

export interface TrajectoryUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: number;
}

export interface TrajectoryRecord {
  id: string;
  seq: number;
  turn: number | null;
  step: number | null;
  kind: TrajectoryKind;
  timestamp: number;
  durationMs: number | null;
  title: string;
  preview: string;
  input?: unknown;
  output?: unknown;
  thinking?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
  usage?: TrajectoryUsage;
  tokensBefore?: number;
  timing?: { ttftMs?: number; decodingMs?: number; totalMs?: number };
  request?: unknown;
  response?: unknown;
  tools?: unknown;
  data?: unknown;
  package?: string;
  surface?: string;
  phase?: string;
  verdict?: string;
  epoch?: number;
  attribution?: unknown;
}

export interface TrajectorySnapshot {
  sessionId: string;
  name?: string;
  cwd?: string;
  generatedAt: number;
  records: TrajectoryRecord[];
}

type AnyRecord = Record<string, any>;

function timestamp(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block: AnyRecord) => {
    if (block?.type === "text") return [String(block.text ?? "")];
    if (block?.type === "thinking") return [String(block.thinking ?? "")];
    return [];
  }).filter(Boolean).join("\n\n");
}

function preview(value: unknown, limit = 180): string {
  const text = typeof value === "string" ? value : textContent(value);
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function usage(value: AnyRecord | undefined): TrajectoryUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    ...(typeof value.input === "number" ? { input: value.input } : {}),
    ...(typeof value.output === "number" ? { output: value.output } : {}),
    ...(typeof value.cacheRead === "number" ? { cacheRead: value.cacheRead } : {}),
    ...(typeof value.cacheWrite === "number" ? { cacheWrite: value.cacheWrite } : {}),
    ...(typeof value.reasoning === "number" ? { reasoning: value.reasoning } : {}),
    ...(typeof value.totalTokens === "number" ? { totalTokens: value.totalTokens } : {}),
    ...(typeof value.cost?.total === "number" ? { cost: value.cost.total } : {}),
  };
}

/** Project Pi's active append-only branch into UniPi's stable trajectory ledger. */
export function projectTrajectory(
  entries: readonly SessionEntry[],
  meta: { sessionId: string; name?: string; cwd?: string },
  telemetry: readonly TelemetryEvent[] = [],
): TrajectorySnapshot {
  const records: TrajectoryRecord[] = [];
  const pendingCalls = new Map<string, { record: TrajectoryRecord; startedAt: number }>();
  let turn = 0;
  let step = 0;

  for (const [seq, typedEntry] of entries.entries()) {
    const entry = typedEntry as unknown as AnyRecord;
    const at = timestamp(entry.timestamp);
    if (entry.type === "message") {
      const message = entry.message as AnyRecord;
      const messageAt = timestamp(message?.timestamp, at);
      if (message?.role === "user") {
        turn++;
        step = 0;
        const body = textContent(message.content);
        records.push({ id: entry.id, seq, turn, step: null, kind: "user", timestamp: messageAt, durationMs: null, title: "USER", preview: preview(body), input: message.content });
        continue;
      }
      if (message?.role === "assistant") {
        step++;
        const blocks = Array.isArray(message.content) ? message.content as AnyRecord[] : [];
        const thinking = blocks.filter(block => block.type === "thinking").map(block => String(block.thinking ?? "")).join("\n\n");
        const output = blocks.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n\n");
        const record: TrajectoryRecord = {
          id: entry.id, seq, turn: turn || null, step, kind: "assistant", timestamp: messageAt,
          durationMs: null, title: "ASSISTANT", preview: preview(output || thinking || (blocks.some(block => block.type === "toolCall") ? "Tool call only" : "")),
          output, ...(thinking ? { thinking } : {}), provider: message.provider, model: message.model,
          stopReason: message.stopReason, isError: message.stopReason === "error", usage: usage(message.usage),
        };
        records.push(record);
        for (const [callIndex, block] of blocks.filter(block => block.type === "toolCall").entries()) {
          const callAt = messageAt + callIndex * 0.001;
          const call: TrajectoryRecord = {
            id: `${entry.id}:${block.id}`, seq: seq + (callIndex + 1) / 1000, turn: turn || null, step,
            kind: "tool", timestamp: callAt, durationMs: null, title: String(block.name ?? "TOOL"),
            preview: preview(JSON.stringify(block.arguments ?? {})), input: block.arguments,
            toolCallId: String(block.id ?? ""), toolName: String(block.name ?? ""),
          };
          records.push(call);
          if (call.toolCallId) pendingCalls.set(call.toolCallId, { record: call, startedAt: callAt });
        }
        continue;
      }
      if (message?.role === "toolResult") {
        const callId = String(message.toolCallId ?? "");
        const pending = pendingCalls.get(callId);
        const body = textContent(message.content);
        if (pending) {
          pending.record.output = message.content;
          pending.record.preview = pending.record.preview || preview(body);
          pending.record.durationMs = Math.max(0, messageAt - pending.startedAt);
          pending.record.isError = Boolean(message.isError);
          pending.record.usage = usage(message.usage);
          pendingCalls.delete(callId);
        } else {
          records.push({ id: entry.id, seq, turn: turn || null, step: step || null, kind: "tool", timestamp: messageAt, durationMs: null, title: String(message.toolName ?? "TOOL"), preview: preview(body), output: message.content, toolCallId: callId, toolName: message.toolName, isError: Boolean(message.isError), usage: usage(message.usage) });
        }
        continue;
      }
      if (message?.role === "bashExecution") {
        records.push({ id: entry.id, seq, turn: turn || null, step: step || null, kind: "tool", timestamp: messageAt, durationMs: null, title: "bash", preview: preview(message.command), input: { command: message.command }, output: message.output, isError: Boolean(message.cancelled || (message.exitCode ?? 0) !== 0) });
      }
      continue;
    }
    if (entry.type === "compaction") {
      records.push({ id: entry.id, seq, turn: null, step: null, kind: "compaction", timestamp: at, durationMs: null, title: "COMPACTED", preview: preview(entry.summary), output: entry.summary, usage: usage(entry.usage), tokensBefore: entry.tokensBefore });
    } else if (entry.type === "branch_summary") {
      records.push({ id: entry.id, seq, turn: null, step: null, kind: "branch", timestamp: at, durationMs: null, title: "BRANCH", preview: preview(entry.summary), output: entry.summary, usage: usage(entry.usage) });
    }
  }

  const firstEntryAt = records[0]?.timestamp ?? Date.now();
  let syntheticSeq = -telemetry.length;
  for (const event of telemetry) {
    if (!["system-prompt", "unipi-trace", "prefix-integrity"].includes(event.type)) continue;
    const data = event.data as AnyRecord | undefined;
    // Package traces are attribution evidence, not a second activity log. Only
    // operations that changed a provider-visible surface belong in trajectory.
    if (event.type === "unipi-trace" && data?.affectsContext !== true) continue;
    const traceAction = String(data?.hook ?? data?.action ?? data?.channel ?? data?.surface ?? "operation");
    const kind: TrajectoryKind = event.type === "system-prompt" ? "system" : event.type === "unipi-trace" ? "unipi" : "prefix";
    const title = event.type === "system-prompt"
      ? "SYSTEM PROMPT"
      : event.type === "unipi-trace"
        ? `${String(data?.package ?? "unipi")} · ${traceAction}`
        : `PREFIX · ${String(data?.verdict ?? "unknown")}`;
    const value = event.type === "system-prompt" ? data?.systemPrompt : data;
    records.push({
      id: `telemetry:${event.type}:${event.at}:${syntheticSeq}`,
      seq: syntheticSeq++,
      turn: event.turnIndex === undefined ? null : event.turnIndex + 1,
      step: null,
      kind,
      timestamp: event.at || firstEntryAt,
      durationMs: typeof data?.durationMs === "number" ? data.durationMs : null,
      title,
      preview: event.type === "prefix-integrity"
        ? `${String(data?.verdict ?? "unknown")} · epoch ${String(data?.epoch ?? "?")}${Array.isArray(data?.differences) && data.differences[0] ? ` · ${String(data.differences[0].path ?? data.differences[0].surface ?? "changed")}` : ""}`
        : preview(event.type === "system-prompt" ? value : JSON.stringify(value ?? {})),
      output: event.type === "system-prompt" ? value : undefined,
      data,
      package: typeof data?.package === "string" ? data.package : undefined,
      surface: typeof data?.surface === "string" ? data.surface : undefined,
      phase: typeof data?.phase === "string" ? data.phase : undefined,
      verdict: typeof data?.verdict === "string" ? data.verdict : undefined,
      epoch: typeof data?.epoch === "number" ? data.epoch : undefined,
      attribution: data?.attribution,
      isError: data?.phase === "error" || data?.verdict === "violation",
      request: event.requestId === undefined ? undefined : { requestId: event.requestId },
    });
  }
  records.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);

  const assistantRecords = records.filter(record => record.kind === "assistant");
  const requestIds = [...new Set(telemetry.flatMap(event => event.type === "request" && event.requestId !== undefined ? [event.requestId] : []))];
  for (const requestId of requestIds) {
    const events = telemetry.filter(event => event.requestId === requestId);
    const requestAt = events.find(event => event.type === "request")?.at ?? 0;
    const record = assistantRecords.find(candidate => candidate.request === undefined && candidate.timestamp >= requestAt)
      ?? assistantRecords.find(candidate => candidate.request === undefined);
    if (!record) break;
    const request = events.find(event => event.type === "request")?.data as AnyRecord | undefined;
    const response = events.find(event => event.type === "response")?.data;
    const end = events.find(event => event.type === "message-end")?.data as AnyRecord | undefined;
    record.request = request;
    record.response = response;
    record.tools = request?.tools;
    record.timing = end === undefined ? undefined : {
      ...(typeof end.ttftMs === "number" ? { ttftMs: end.ttftMs } : {}),
      ...(typeof end.decodingMs === "number" ? { decodingMs: end.decodingMs } : {}),
      ...(typeof end.totalMs === "number" ? { totalMs: end.totalMs } : {}),
    };
    if (typeof end?.totalMs === "number") record.durationMs = end.totalMs;
  }
  for (const record of records.filter(record => record.kind === "tool" && record.toolCallId)) {
    const end = telemetry.find(event => event.type === "tool-end" && event.toolCallId === record.toolCallId)?.data as AnyRecord | undefined;
    if (typeof end?.durationMs === "number") record.durationMs = end.durationMs;
  }
  records.forEach((record, index) => { record.seq = index; });

  return { ...meta, generatedAt: Date.now(), records };
}
