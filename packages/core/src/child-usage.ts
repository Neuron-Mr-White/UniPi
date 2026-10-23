/**
 * Child-agent usage ledger — makes the lead session's cost include what its
 * child agents spend.
 *
 * Graph / swarm work, subagents, the Fusion sidekick and `bg_run` agent
 * tasks all run as separate pi processes. Their assistant messages land in
 * their own session files, so a lead that only sums its own assistant
 * `usage.cost` under-reports the price of any multi-agent mode.
 *
 * Owners record each child usage delta into the LEAD session as a custom
 * entry (`unipi-child-usage`). Custom entries are persisted, branch-scoped
 * and never model-facing, so the footer / app bridge / info screen can fold
 * them in alongside assistant usage and survive reloads. Live consumers that
 * don't rescan the branch (the app bridge) subscribe via `onChildUsage`.
 */

/** Custom entry type carrying one child usage delta. */
export const CHILD_USAGE_ENTRY = "unipi-child-usage";

export type ChildUsageSource = "subagent" | "fusion" | "bg-task";

export interface ChildUsageData {
  v: 1;
  source: ChildUsageSource;
  /** Agent / task id inside its owner. */
  id: string;
  /** `provider/model` when known. */
  model?: string;
  /** False when the child's own session file already lives under the global
   *  pi sessions dir (bg_run agents), so cross-session stats (info screen)
   *  must not count it twice. */
  standalone: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD, as reported by the child's pi. */
  cost: number;
}

export interface ChildUsageDelta {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: unknown;
}

type Listener = (data: ChildUsageData) => void;

const LISTENERS = Symbol.for("unipi.child-usage.listeners");

function listeners(): Set<Listener> {
  const g = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
  return (g[LISTENERS] ??= new Set<Listener>());
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Build the entry payload; undefined when the delta carries nothing. */
export function childUsageData(
  meta: { source: ChildUsageSource; id: string; model?: string; standalone?: boolean },
  delta: ChildUsageDelta,
): ChildUsageData | undefined {
  const data: ChildUsageData = {
    v: 1,
    source: meta.source,
    id: meta.id,
    ...(meta.model ? { model: meta.model } : {}),
    standalone: meta.standalone ?? true,
    input: num(delta.input),
    output: num(delta.output),
    cacheRead: num(delta.cacheRead),
    cacheWrite: num(delta.cacheWrite),
    cost: num(delta.cost),
  };
  if (data.input + data.output + data.cacheRead + data.cacheWrite + data.cost === 0) return undefined;
  return data;
}

/**
 * Persist one child usage delta into the lead session and notify live
 * listeners. Never throws — accounting must not affect the child run.
 */
export function recordChildUsage(
  appendEntry: (customType: string, data: ChildUsageData) => void,
  meta: { source: ChildUsageSource; id: string; model?: string; standalone?: boolean },
  delta: ChildUsageDelta,
): void {
  const data = childUsageData(meta, delta);
  if (data === undefined) return;
  try {
    appendEntry(CHILD_USAGE_ENTRY, data);
  } catch {
    return; // session gone — nothing to account into
  }
  for (const listener of listeners()) {
    try {
      listener(data);
    } catch {
      /* a listener never affects accounting */
    }
  }
}

/** Subscribe to recorded child usage (live cost displays). */
export function onChildUsage(listener: Listener): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

/** The child usage payload of a session entry, or undefined. */
export function childUsageOf(entry: unknown): ChildUsageData | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (e.type !== "custom" || e.customType !== CHILD_USAGE_ENTRY) return undefined;
  const d = e.data as Partial<ChildUsageData> | undefined;
  if (!d || typeof d !== "object") return undefined;
  return {
    v: 1,
    source: (d.source ?? "subagent") as ChildUsageSource,
    id: typeof d.id === "string" ? d.id : "",
    ...(typeof d.model === "string" ? { model: d.model } : {}),
    standalone: d.standalone !== false,
    input: num(d.input),
    output: num(d.output),
    cacheRead: num(d.cacheRead),
    cacheWrite: num(d.cacheWrite),
    cost: num(d.cost),
  };
}
