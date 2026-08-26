import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
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
/** Only a small recent tail is needed by the live context inspector. */
const MAX_READ_BYTES = 5_000_000;

interface SharedSidecarState {
  events: TelemetryEvent[];
  sizes: number[];
  retainedBytes: number;
  revision: number;
}

const sharedStates = new Map<string, SharedSidecarState>();

function readTail(file: string): { events: TelemetryEvent[]; sizes: number[] } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, MAX_READ_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(file, "r");
    readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);
    const events: TelemetryEvent[] = [];
    const sizes: number[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as TelemetryEvent);
        sizes.push(Buffer.byteLength(line) + 1);
      } catch { /* Ignore an incomplete or malformed line. */ }
    }
    return { events, sizes };
  } catch {
    return { events: [], sizes: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function stateFor(file: string): SharedSidecarState {
  const existing = sharedStates.get(file);
  if (existing) return existing;
  const loaded = readTail(file);
  const state = {
    events: loaded.events,
    sizes: loaded.sizes,
    retainedBytes: loaded.sizes.reduce((total, size) => total + size, 0),
    revision: 0,
  };
  sharedStates.set(file, state);
  return state;
}

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
  private readonly state: SharedSidecarState;

  constructor(sessionId: string, root = join(homedir(), ".unipi", "trajectory")) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, `${sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
    this.state = stateFor(this.file);
  }

  append(event: Omit<TelemetryEvent, "v">): void {
    const safe = redactTelemetry({ v: 1, ...event }) as TelemetryEvent;
    const serialized = JSON.stringify(safe);
    const bytes = Buffer.byteLength(serialized) + 1;
    if (bytes > MAX_EVENT_BYTES) return;
    appendFileSync(this.file, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
    this.state.events.push(safe);
    this.state.sizes.push(bytes);
    this.state.retainedBytes += bytes;
    this.state.revision++;
    while (this.state.retainedBytes > MAX_READ_BYTES && this.state.events.length > 1) {
      this.state.events.shift();
      this.state.retainedBytes -= this.state.sizes.shift() ?? 0;
    }
  }

  /** Return the cached recent tail; this never rereads the whole JSONL file. */
  read(): TelemetryEvent[] {
    return this.state.events.slice();
  }

  revision(): number {
    return this.state.revision;
  }
}

