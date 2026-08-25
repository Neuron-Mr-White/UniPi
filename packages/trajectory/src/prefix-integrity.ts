import { createHash } from "node:crypto";

export type PrefixVerdict = "first_request" | "identical_retry" | "prefix_extended" | "boundary" | "violation";

export interface PrefixDifference {
  surface: "messages" | "system" | "tools" | "envelope" | "shape";
  kind: "changed" | "inserted" | "removed" | "reordered";
  path: string;
  index?: number;
  beforeFingerprint?: string;
  afterFingerprint?: string;
}

export interface PrefixIntegrityResult {
  epoch: number;
  verdict: PrefixVerdict;
  messageField: string;
  previousItems: number;
  currentItems: number;
  extendedBy: number;
  requestFingerprint: string;
  messagesFingerprint: string;
  systemFingerprint: string;
  toolsFingerprint: string;
  envelopeFingerprint: string;
  boundaryReason?: string;
  differences: PrefixDifference[];
}

interface RequestState {
  requestFingerprint: string;
  messageField: string;
  messages: unknown[];
  messageFingerprints: string[];
  systemFingerprint: string;
  toolsFingerprint: string;
  envelopeFingerprint: string;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: "number", value: String(value) };
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return { $type: "cycle" };
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (value instanceof Uint8Array) {
    seen.delete(value);
    return { $type: "bytes", length: value.byteLength };
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex").slice(0, 16);
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : { payload };
}

function messageSequence(payload: Record<string, unknown>): { field: string; items: unknown[] } {
  for (const field of ["messages", "input", "contents"] as const) {
    if (Array.isArray(payload[field])) return { field, items: payload[field] as unknown[] };
  }
  return { field: "none", items: [] };
}

function systemSurface(payload: Record<string, unknown>, field: string, messages: unknown[]): unknown {
  const direct = Object.fromEntries(Object.entries(payload).filter(([key]) => /^(system|instructions|developer)/i.test(key)));
  const leading = field === "messages"
    ? messages.filter((message) => {
      if (!message || typeof message !== "object") return false;
      const role = (message as Record<string, unknown>).role;
      return role === "system" || role === "developer";
    })
    : [];
  return { direct, leading };
}

function toolsSurface(payload: Record<string, unknown>): unknown {
  return { tools: payload.tools, toolChoice: payload.tool_choice ?? payload.toolChoice };
}

function envelopeSurface(payload: Record<string, unknown>, sequenceField: string): unknown {
  const omitted = new Set([sequenceField, "tools", "tool_choice", "toolChoice"]);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !omitted.has(key) && !/^(system|instructions|developer)/i.test(key)));
}

function state(payload: unknown, route?: unknown): RequestState {
  const object = payloadObject(payload);
  const sequence = messageSequence(object);
  const system = systemSurface(object, sequence.field, sequence.items);
  const tools = toolsSurface(object);
  const envelope = { route, payload: envelopeSurface(object, sequence.field) };
  return {
    requestFingerprint: fingerprint({ route, payload: object }),
    messageField: sequence.field,
    messages: sequence.items,
    messageFingerprints: sequence.items.map(fingerprint),
    systemFingerprint: fingerprint(system),
    toolsFingerprint: fingerprint(tools),
    envelopeFingerprint: fingerprint(envelope),
  };
}

function messageDifference(previous: RequestState, current: RequestState): PrefixDifference | undefined {
  if (previous.messageField !== current.messageField) {
    return { surface: "shape", kind: "changed", path: "$.messageField", beforeFingerprint: fingerprint(previous.messageField), afterFingerprint: fingerprint(current.messageField) };
  }
  const limit = Math.min(previous.messageFingerprints.length, current.messageFingerprints.length);
  for (let index = 0; index < limit; index++) {
    if (previous.messageFingerprints[index] === current.messageFingerprints[index]) continue;
    const laterIndex = current.messageFingerprints.indexOf(previous.messageFingerprints[index]!, index + 1);
    const earlierIndex = previous.messageFingerprints.indexOf(current.messageFingerprints[index]!, index + 1);
    return {
      surface: "messages",
      kind: laterIndex >= 0 || earlierIndex >= 0 ? "reordered" : "changed",
      path: `$.${current.messageField}[${index}]`, index,
      beforeFingerprint: previous.messageFingerprints[index], afterFingerprint: current.messageFingerprints[index],
    };
  }
  if (current.messageFingerprints.length < previous.messageFingerprints.length) {
    const index = current.messageFingerprints.length;
    return { surface: "messages", kind: "removed", path: `$.${current.messageField}[${index}]`, index, beforeFingerprint: previous.messageFingerprints[index] };
  }
  return undefined;
}

export class PrefixIntegrityTracker {
  private epoch = 0;
  private previous: RequestState | null = null;
  private boundaryReason: string | undefined;

  reset(): void {
    this.epoch = 0;
    this.previous = null;
    this.boundaryReason = undefined;
  }

  markBoundary(reason: string): void {
    if (this.previous) this.epoch++;
    this.previous = null;
    this.boundaryReason = reason;
  }

  observe(payload: unknown, route?: unknown): PrefixIntegrityResult {
    const current = state(payload, route);
    const boundaryReason = this.boundaryReason;
    if (!this.previous) {
      if (this.epoch === 0) this.epoch = 1;
      this.previous = current;
      this.boundaryReason = undefined;
      return {
        epoch: this.epoch,
        verdict: boundaryReason ? "boundary" : "first_request",
        messageField: current.messageField,
        previousItems: 0,
        currentItems: current.messages.length,
        extendedBy: current.messages.length,
        requestFingerprint: current.requestFingerprint,
        messagesFingerprint: fingerprint(current.messageFingerprints),
        systemFingerprint: current.systemFingerprint,
        toolsFingerprint: current.toolsFingerprint,
        envelopeFingerprint: current.envelopeFingerprint,
        ...(boundaryReason ? { boundaryReason } : {}),
        differences: [],
      };
    }

    const previous = this.previous;
    const differences: PrefixDifference[] = [];
    const messageDiff = messageDifference(previous, current);
    if (messageDiff) differences.push(messageDiff);
    if (previous.systemFingerprint !== current.systemFingerprint) differences.push({ surface: "system", kind: "changed", path: "$.system", beforeFingerprint: previous.systemFingerprint, afterFingerprint: current.systemFingerprint });
    if (previous.toolsFingerprint !== current.toolsFingerprint) differences.push({ surface: "tools", kind: "changed", path: "$.tools", beforeFingerprint: previous.toolsFingerprint, afterFingerprint: current.toolsFingerprint });
    if (previous.envelopeFingerprint !== current.envelopeFingerprint) differences.push({ surface: "envelope", kind: "changed", path: "$.envelope", beforeFingerprint: previous.envelopeFingerprint, afterFingerprint: current.envelopeFingerprint });

    const verdict: PrefixVerdict = current.requestFingerprint === previous.requestFingerprint
      ? "identical_retry"
      : differences.length === 0
        ? "prefix_extended"
        : "violation";
    const result: PrefixIntegrityResult = {
      epoch: this.epoch,
      verdict,
      messageField: current.messageField,
      previousItems: previous.messages.length,
      currentItems: current.messages.length,
      extendedBy: Math.max(0, current.messages.length - previous.messages.length),
      requestFingerprint: current.requestFingerprint,
      messagesFingerprint: fingerprint(current.messageFingerprints),
      systemFingerprint: current.systemFingerprint,
      toolsFingerprint: current.toolsFingerprint,
      envelopeFingerprint: current.envelopeFingerprint,
      differences,
    };
    this.previous = current;
    return result;
  }
}
