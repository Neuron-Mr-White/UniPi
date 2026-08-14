import { createHmac, randomBytes } from "node:crypto";

export type PrefixTransition =
  | "first_request"
  | "prefix_extended"
  | "identical_retry"
  | "envelope_changed"
  | "history_rewritten"
  | "payload_shape_changed";

export interface PrefixCacheSnapshot {
  epoch: number;
  requests: number;
  prefixExtensions: number;
  identicalRetries: number;
  boundaries: number;
  lastTransition: PrefixTransition | "none";
  requestFingerprint: string;
  envelopeFingerprint: string;
  sequenceField: string;
  sequenceItems: number;
  route: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    responses: number;
  };
}

interface ObservedRequest {
  envelopeFingerprint: string;
  requestFingerprint: string;
  sequenceField: string;
  sequenceItemFingerprints: string[];
}

const EMPTY_SNAPSHOT: PrefixCacheSnapshot = {
  epoch: 0,
  requests: 0,
  prefixExtensions: 0,
  identicalRetries: 0,
  boundaries: 0,
  lastTransition: "none",
  requestFingerprint: "none",
  envelopeFingerprint: "none",
  sequenceField: "none",
  sequenceItems: 0,
  route: "unknown",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 },
};

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { $type: "number", value: String(value) };
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return { $type: "cycle" };
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }

  if (value instanceof Uint8Array) {
    seen.delete(value);
    return { $type: "bytes", length: value.byteLength };
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    result[key] = canonicalize(record[key], seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function routeLabel(model: unknown): string {
  if (!model || typeof model !== "object") return "unknown";
  const value = model as Record<string, unknown>;
  return [value.provider, value.id, value.api]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("/") || "unknown";
}

function findSequence(payload: Record<string, unknown>): { field: string; items: unknown[] } {
  for (const field of ["messages", "input", "contents"] as const) {
    if (Array.isArray(payload[field])) return { field, items: payload[field] as unknown[] };
  }
  return { field: "none", items: [] };
}

function isPrefix(previous: string[], current: string[]): boolean {
  return previous.length <= current.length && previous.every((item, index) => current[index] === item);
}

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Session-local, privacy-safe prefix observability.
 *
 * Prompt/tool bytes are only canonicalized transiently. The tracker retains
 * keyed HMACs and counters, never raw provider payloads. Its random key is not
 * persisted, so fingerprints cannot be correlated across process lifetimes or
 * used as a precomputed dictionary oracle.
 */
export class PrefixCacheTracker {
  private readonly key: Uint8Array;
  private previous: ObservedRequest | null = null;
  private seenResponses = new WeakSet<object>();
  private snapshot: PrefixCacheSnapshot = structuredClone(EMPTY_SNAPSHOT);

  constructor(key: Uint8Array = randomBytes(32)) {
    this.key = key;
  }

  reset(): void {
    this.previous = null;
    this.seenResponses = new WeakSet<object>();
    this.snapshot = structuredClone(EMPTY_SNAPSHOT);
  }

  private fingerprint(value: unknown): string {
    return createHmac("sha256", this.key).update(canonicalJson(value)).digest("hex").slice(0, 16);
  }

  observeRequest(payload: unknown, model?: unknown): PrefixCacheSnapshot {
    const object = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : { payload };
    const { field, items } = findSequence(object);
    const route = routeLabel(model);
    const envelope: Record<string, unknown> = { route };
    for (const [key, value] of Object.entries(object)) {
      if (key !== field) envelope[key] = value;
    }

    const current: ObservedRequest = {
      envelopeFingerprint: this.fingerprint(envelope),
      requestFingerprint: this.fingerprint(object),
      sequenceField: field,
      sequenceItemFingerprints: items.map((item) => this.fingerprint(item)),
    };

    let transition: PrefixTransition;
    let epoch = this.snapshot.epoch;
    if (!this.previous) {
      transition = "first_request";
      epoch = Math.max(1, epoch);
    } else if (
      current.envelopeFingerprint !== this.previous.envelopeFingerprint
    ) {
      transition = "envelope_changed";
      epoch++;
    } else if (current.sequenceField !== this.previous.sequenceField) {
      transition = "payload_shape_changed";
      epoch++;
    } else if (current.requestFingerprint === this.previous.requestFingerprint) {
      transition = "identical_retry";
    } else if (isPrefix(this.previous.sequenceItemFingerprints, current.sequenceItemFingerprints)) {
      transition = "prefix_extended";
    } else {
      transition = "history_rewritten";
      epoch++;
    }

    this.snapshot = {
      ...this.snapshot,
      epoch,
      requests: this.snapshot.requests + 1,
      prefixExtensions: this.snapshot.prefixExtensions + (transition === "prefix_extended" ? 1 : 0),
      identicalRetries: this.snapshot.identicalRetries + (transition === "identical_retry" ? 1 : 0),
      boundaries: this.snapshot.boundaries + (
        transition === "envelope_changed" || transition === "history_rewritten" || transition === "payload_shape_changed"
          ? 1
          : 0
      ),
      lastTransition: transition,
      requestFingerprint: current.requestFingerprint,
      envelopeFingerprint: current.envelopeFingerprint,
      sequenceField: current.sequenceField,
      sequenceItems: current.sequenceItemFingerprints.length,
      route,
    };
    this.previous = current;
    return this.getSnapshot();
  }

  observeMessages(messages: unknown[]): PrefixCacheSnapshot {
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const value = message as Record<string, unknown>;
      if (value.role !== "assistant" || !value.usage || typeof value.usage !== "object") continue;
      if (value.stopReason === "error" || value.stopReason === "aborted") continue;

      // agent_end can expose the whole active context repeatedly. Deduplicate
      // exact message objects by identity; two genuinely distinct provider
      // responses with identical content/usage must still both count.
      if (this.seenResponses.has(message as object)) continue;
      this.seenResponses.add(message as object);

      const usage = value.usage as Record<string, unknown>;
      this.snapshot.usage.input += usageNumber(usage.input);
      this.snapshot.usage.output += usageNumber(usage.output);
      this.snapshot.usage.cacheRead += usageNumber(usage.cacheRead);
      this.snapshot.usage.cacheWrite += usageNumber(usage.cacheWrite);
      this.snapshot.usage.responses++;
    }
    return this.getSnapshot();
  }

  markBoundary(transition: Extract<PrefixTransition, "history_rewritten" | "envelope_changed">): void {
    // Lifecycle events can identify a boundary before the next payload arrives.
    // Drop the comparison baseline so the next request starts a fresh observed
    // epoch rather than being misclassified against pre-boundary history.
    if (this.previous) {
      this.snapshot.epoch++;
      this.snapshot.boundaries++;
    }
    this.snapshot.lastTransition = transition;
    this.previous = null;
  }

  getSnapshot(): PrefixCacheSnapshot {
    return structuredClone(this.snapshot);
  }
}

export function formatPrefixCacheStats(snapshot: PrefixCacheSnapshot): string {
  const usage = snapshot.usage;
  const totalPrompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const readRate = totalPrompt > 0 ? `${((usage.cacheRead / totalPrompt) * 100).toFixed(1)}%` : "n/a";
  return [
    "## Provider Prefix Cache",
    "",
    `- Epoch: ${snapshot.epoch || "not observed"}`,
    `- Requests observed: ${snapshot.requests}`,
    `- Prefix extensions: ${snapshot.prefixExtensions}`,
    `- Explicit boundaries: ${snapshot.boundaries}`,
    `- Last transition: ${snapshot.lastTransition}`,
    `- Route: ${snapshot.route}`,
    `- Request fingerprint: ${snapshot.requestFingerprint}`,
    `- Envelope fingerprint: ${snapshot.envelopeFingerprint}`,
    `- Provider cache read: ${usage.cacheRead} tokens`,
    `- Provider cache write: ${usage.cacheWrite} tokens`,
    `- Observed cache-read share: ${readRate}`,
    "",
    "Fingerprints are session-local keyed HMACs. Raw prompts, messages, tool arguments, and payloads are not retained or logged.",
    "A prefix extension indicates structural eligibility only; provider cache retention and routing still determine actual hits.",
  ].join("\n");
}
