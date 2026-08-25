import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TelemetryEventType =
  | "hook"
  | "unipi-trace"
  | "prefix-integrity"
  | "system-prompt"
  | "request"
  | "response"
  | "first-token"
  | "message-end"
  | "tool-start"
  | "tool-end";

export interface TelemetryEvent {
  v: 1;
  type: TelemetryEventType;
  at: number;
  requestId?: number | string;
  runId?: number | string;
  turnIndex?: number;
  toolCallId?: string;
  data?: unknown;
}

const SECRET_KEY = /authorization|api[-_]?key|token|cookie|secret|password|credential/i;
const SECRET_VALUE = /^(?:bearer\s+|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|AIza[a-z0-9_-]{20,})/i;
const MAX_STRING = 200_000;
/** Hard ceiling on a serialized event; guards against pathological payloads. */
const MAX_EVENT_BYTES = 2_000_000;
/** Sidecar reads are capped so projection cannot allocate unbounded memory. */
const MAX_READ_BYTES = 20_000_000;

export function redactTelemetry(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value.trim())) return "[REDACTED]";
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactTelemetry(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? "[REDACTED]" : redactTelemetry(item, seen),
  ]));
}

export class TelemetrySidecar {
  readonly file: string;

  constructor(sessionId: string, root = join(homedir(), ".unipi", "trajectory")) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
  }

  append(event: Omit<TelemetryEvent, "v">): void {
    const serialized = JSON.stringify(redactTelemetry({ v: 1, ...event }));
    if (serialized.length > MAX_EVENT_BYTES) return;
    appendFileSync(this.file, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
  }

  read(): TelemetryEvent[] {
    try {
      let lines = readFileSync(this.file, "utf8");
      if (lines.length > MAX_READ_BYTES) {
        // Keep the most recent events; skip complete earlier lines.
        const keep = lines.slice(lines.length - MAX_READ_BYTES);
        lines = keep.slice(keep.indexOf("\n") + 1);
      }
      return lines.split("\n").filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as TelemetryEvent]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }
}

