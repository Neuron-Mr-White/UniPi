/**
 * @unipi/core — harness message provenance.
 *
 * Harness-generated text that reaches the model as role USER (direct
 * sendUserMessage) is annotated with a namespaced `unipiHarness` metadata field
 * so the UI can style it — model roles, text, delivery and admission behavior
 * stay untouched.
 *
 * Lifecycle (single-call synchronous arm — the SDK runs `input` handlers
 * synchronously inside sendUserMessage):
 *  1. `sendHarnessUserMessage` ensures the observers are installed, pushes a
 *     single-call ARM, calls the unchanged `pi.sendUserMessage`, and pops the
 *     arm in `finally` — nothing lingers across calls.
 *  2. The input handler run DURING that call confirms the arm (source
 *     `extension`, exact text). Human/rpc inputs and extension inputs without
 *     an active arm become human/unattributed admission records.
 *  3. Idle (non-queued) harness records are dispatch-eligible only after
 *     `before_agent_start` carries the exact prompt (auth/model passed).
 *     Queued records are eligible from their confirmed delivery while active.
 *  4. `message_start` selects among ELIGIBLE harness records; human/
 *     unattributed records participate in conflict detection but never label.
 *     Identical texts with conflicting origins — across deliveries — fail
 *     CLOSED and clear the whole matching group. The selected message is
 *     marked processed; `message_end` never re-selects.
 *  5. `message_end` attaches `unipiHarness` only when the finalized text still
 *     equals the selected text (later transforms fail closed). SessionManager
 *     persists the whole object, so provenance survives resume/branch.
 *
 * Irreducible SDK gap: input events carry no per-send ID. The next input
 * purges ALL unmatched direct records (harness + human/rpc) and terminal
 * boundaries purge everything outstanding — the failure mode is always native
 * fallback, never a human message mislabelled.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HarnessDelivery =
  | "direct"
  | "steer"
  | "followUp"
  | "nextTurn"
  | "boundary"
  | "before_agent_start";

export interface HarnessMessageMeta {
  version: 1;
  id: string;
  source: string;
  title: string;
  synopsis?: string;
  delivery: HarnessDelivery;
  severity?: "warning";
}

export type HarnessMessageMetaInput = Omit<HarnessMessageMeta, "version" | "id" | "delivery">;

/** Canonical per-API state, carried on the API ROOT via a Symbol.for property.
 * Proxies (withCommandEcho, the umbrella registerTool proxy) forward unknown
 * property gets/sets to their target, so every wrapper observes one state. */
const STATE_SYM = Symbol.for("unipi.harnessMessages.state");

interface HarnessToken {
  kind: "harness";
  origin: string;
  title: string;
  synopsis?: string;
  severity?: "warning";
  text: string;
  delivery: "direct" | "steer" | "followUp";
  /** Direct records become eligible only at before_agent_start. */
  eligible: boolean;
  state: "admitted" | "consumed";
  seq: number;
}

interface HarnessHumanRecord {
  kind: "human" | "unattributed";
  origin: string;
  text: string;
  delivery: "direct" | "steer" | "followUp";
  state: "admitted" | "consumed";
  seq: number;
}

type AdmissionRecord = HarnessToken | HarnessHumanRecord;

interface Arm {
  origin: string;
  title: string;
  synopsis?: string;
  severity?: "warning";
  text: string;
  delivery: "direct" | "steer" | "followUp";
  seq: number;
}

export interface HarnessRegistryState {
  records: AdmissionRecord[];
  seq: number;
  arms: Arm[];
  /** message object → { meta, text } (set at message_start). */
  pendingMeta: WeakMap<object, { meta: HarnessMessageMeta; text: string }>;
  /** messages whose selection already happened — message_end never re-selects. */
  processed: WeakSet<object>;
  installed: boolean;
}

function stateFor(pi: object): HarnessRegistryState {
  const existing = (pi as { [STATE_SYM]?: HarnessRegistryState })[STATE_SYM];
  if (existing) return existing;
  const state: HarnessRegistryState = {
    records: [],
    seq: 0,
    arms: [],
    pendingMeta: new WeakMap(),
    processed: new WeakSet(),
    installed: false,
  };
  try {
    Object.defineProperty(pi, STATE_SYM, { value: state, enumerable: false, configurable: false, writable: false });
  } catch {
    // Frozen hosts: fall back to an instance-local property (single-proxy use).
    try {
      (pi as { [STATE_SYM]?: HarnessRegistryState })[STATE_SYM] = state;
    } catch {
      // Absolutely frozen: operate armless — sends stay UNTRACKED (native).
    }
  }
  return (pi as { [STATE_SYM]?: HarnessRegistryState })[STATE_SYM] ?? state;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `hm-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Build a stable namespaced meta (no date header — ids are monotonic). */
export function harnessMetadata(meta: HarnessMessageMetaInput, delivery: HarnessDelivery): HarnessMessageMeta {
  return { version: 1, id: nextId(), delivery, ...meta };
}

/** Details payload for tool results: provenance header data for annotations
 * appended to the result content (fusion nudges, kanboard R1, watchdog kill). */
export interface HarnessToolAnnotation {
  meta: HarnessMessageMeta;
  text: string;
}

export function harnessToolResultDetails(
  eventDetails: unknown,
  meta: HarnessMessageMetaInput,
  delivery: HarnessDelivery,
  text: string,
): Record<string, unknown> {
  const existing = (eventDetails as { unipiHarnessAnnotations?: unknown } | null | undefined)?.unipiHarnessAnnotations;
  const list = Array.isArray(existing) ? existing : [];
  return {
    ...((eventDetails as Record<string, unknown> | null | undefined) ?? {}),
    unipiHarnessAnnotations: [...list, { meta: harnessMetadata(meta, delivery), text }],
  };
}

/** Namespaced read of harness metadata from a message or details object. */
export function readHarnessMeta(source: unknown): HarnessMessageMeta | undefined {
  const meta = (source as { unipiHarness?: unknown } | null | undefined)?.unipiHarness ?? source;
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Partial<HarnessMessageMeta>;
  const ALLOWED_DELIVERY: readonly string[] = ["direct", "steer", "followUp", "nextTurn", "boundary", "before_agent_start"];
  if (
    m.version !== 1 || typeof m.id !== "string" || typeof m.source !== "string" ||
    typeof m.title !== "string" || typeof m.delivery !== "string" || !ALLOWED_DELIVERY.includes(m.delivery)
  ) {
    return undefined;
  }
  return m as HarnessMessageMeta;
}

/** Extract the exact text the SDK renders/queues for a user message. */
export function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
}

function userTextFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "user") return "";
  return userMessageText(m.content);
}

/**
 * Send a harness-generated user message through the UNCHANGED
 * `pi.sendUserMessage` with a synchronous single-call provenance arm. Returns
 * the raw sender's value (callers may await; failures propagate unchanged).
 * Provenance tracking is best-effort: if observers cannot install on this API,
 * the raw send proceeds untracked (native fallback).
 */
export function sendHarnessUserMessage(
  pi: ExtensionAPI,
  content: string,
  meta: HarnessMessageMetaInput,
  options?: { deliverAs?: "steer" | "followUp" },
): ReturnType<ExtensionAPI["sendUserMessage"]> {
  let arm: Arm | undefined;
  try {
    try {
      installHarnessProvenance(pi);
      const state = stateFor(pi);
      state.seq += 1;
      arm = {
        origin: meta.source,
        title: meta.title,
        synopsis: meta.synopsis,
        severity: meta.severity,
        text: content,
        delivery: options?.deliverAs ?? "direct",
        seq: state.seq,
      };
      state.arms.push(arm);
    } catch {
      // Observers/state unavailable (frozen host): send untracked.
      arm = undefined;
    }
    return pi.sendUserMessage(content, options);
  } finally {
    // The input handler ran synchronously inside the call (or never ran —
    // compaction/auth failure). Either way the arm dies with the call: an
    // unconfirmed arm leaves NO token, so nothing can mismatch later sends.
    if (arm) {
      const idx = stateFor(pi).arms.indexOf(arm);
      if (idx !== -1) stateFor(pi).arms.splice(idx, 1);
    }
  }
}

const DELIVERY_ORDER: Record<string, number> = { direct: 0, steer: 1, followUp: 2 };

/** Prune consumed records immediately (bounded arrays over long runs). */
function prune(state: HarnessRegistryState): void {
  if (state.records.some((r) => r.state === "consumed")) {
    state.records = state.records.filter((r) => r.state !== "consumed");
  }
}

/** Select the outstanding admission record for an arriving user message.
 * Only ELIGIBLE harness records can label; human/unattributed records
 * participate in conflict detection but never label. Identical texts with
 * conflicting origins — across deliveries — fail closed and clear the whole
 * matching group. */
function selectRecord(state: HarnessRegistryState, text: string): HarnessMessageMeta | undefined {
  const candidates = state.records.filter(
    (r) => r.state === "admitted" && r.text === text && (r.kind !== "harness" || r.eligible),
  );
  if (candidates.length === 0) return undefined;
  const origins = new Set(candidates.map((r) => r.origin));
  if (origins.size > 1) {
    for (const r of candidates) r.state = "consumed";
    prune(state);
    return undefined;
  }
  candidates.sort((a, b) => (DELIVERY_ORDER[a.delivery] ?? 3) - (DELIVERY_ORDER[b.delivery] ?? 3) || a.seq - b.seq);
  const chosen = candidates[0]!;
  for (const r of candidates) r.state = "consumed";
  prune(state); // consumed records never linger, even on normal success
  if (chosen.kind !== "harness") return undefined;
  return harnessMetadata(
    { source: chosen.origin, title: chosen.title, synopsis: chosen.synopsis, severity: chosen.severity },
    chosen.delivery,
  );
}

/**
 * Install the provenance observers. Idempotent per API ROOT (state travels with
 * the root through proxies). Model roles/text/delivery/admission are untouched;
 * the only behavior change is the namespaced `unipiHarness` field on harness
 * user messages.
 */
export function installHarnessProvenance(pi: ExtensionAPI): void {
  const state = stateFor(pi);
  if (state.installed) return;
  state.installed = true;
  const onAny = pi.on as unknown as (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;

  onAny("input", (event) => {
    const ev = (event ?? {}) as { text?: unknown; source?: unknown; streamingBehavior?: unknown };
    const text = typeof ev.text === "string" ? ev.text : "";
    const source = typeof ev.source === "string" ? ev.source : "interactive";
    const streaming = ev.streamingBehavior === "steer" || ev.streamingBehavior === "followUp";
    // Effective delivery: the queued value ONLY while streaming (the real SDK
    // omits streamingBehavior on idle events even when the caller passed one —
    // an idle followUp option is ignored and dispatches direct).
    const effective = streaming ? (ev.streamingBehavior as "steer" | "followUp") : "direct";
    // The next input invalidates ALL unmatched direct records (harness and
    // human/rpc alike) — bounds failed/aborted sends. Queued stays.
    state.records = state.records.filter(
      (r) => !(r.delivery === "direct" && r.state === "admitted"),
    );
    state.seq += 1;
    const arm = state.arms[state.arms.length - 1];
    if (arm && source === "extension" && text === arm.text) {
      state.records.push({
        kind: "harness",
        origin: arm.origin,
        title: arm.title,
        synopsis: arm.synopsis,
        severity: arm.severity,
        text: arm.text,
        delivery: effective,
        // Queued is eligible immediately; idle direct only at before_agent_start.
        eligible: streaming,
        state: "admitted",
        seq: arm.seq,
      });
      prune(state);
      return;
    }
    state.records.push({
      kind: source === "extension" ? "unattributed" : "human",
      origin: source,
      text,
      delivery: effective,
      state: "admitted",
      seq: state.seq,
    });
    prune(state);
  });

  onAny("before_agent_start", (event) => {
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt !== "string") return;
    // Idle harness records matching THIS prompt become eligible; other
    // unconfirmed direct records are stale and dropped. Queued untouched.
    for (const r of state.records) {
      if (r.kind === "harness" && r.delivery === "direct" && r.state === "admitted") {
        if (r.text === prompt) r.eligible = true;
      }
    }
    state.records = state.records.filter(
      (r) => !(r.kind === "harness" && r.delivery === "direct" && r.state === "admitted" && !r.eligible),
    );
    prune(state);
  });

  onAny("message_start", (event) => {
    const message = (event as { message?: unknown } | undefined)?.message;
    if (!message || typeof message !== "object") return;
    const text = userTextFromMessage(message);
    state.processed.add(message as object);
    if (!text) return;
    const meta = selectRecord(state, text);
    if (meta) state.pendingMeta.set(message as object, { meta, text });
  });

  onAny("message_end", (event) => {
    const message = (event as { message?: unknown } | undefined)?.message;
    if (!message || typeof message !== "object") return undefined;
    if (!state.processed.has(message as object)) return undefined; // never re-select
    const pending = state.pendingMeta.get(message as object);
    if (!pending) return undefined;
    state.pendingMeta.delete(message as object);
    // Later transforms: attach only if the finalized text is still the
    // selected text (original content identity preserved either way).
    if (userTextFromMessage(message) !== pending.text) return undefined;
    return { message: { ...(message as Record<string, unknown>), unipiHarness: pending.meta } };
  });

  // Terminal boundary: purge everything outstanding (queued records were
  // consumed by their message_start before agent_end).
  onAny("agent_settled", () => {
    state.records = state.records.filter((r) => r.state === "consumed");
    prune(state);
    state.arms.length = 0;
  });

  // Fresh session context: pending state from the old tree is meaningless.
  for (const evt of ["session_before_switch", "session_before_fork", "session_before_tree", "session_start", "session_shutdown"]) {
    onAny(evt, () => {
      state.records = [];
      state.pendingMeta = new WeakMap();
      state.processed = new WeakSet();
    });
  }
}

/** Test hook: inspect the per-API state. */
export function harnessStateForTests(pi: object): HarnessRegistryState {
  return stateFor(pi);
}
