/**
 * Cut logic — buildOwnCut for determining compaction boundaries
 * (parity-aligned with pi-vcc before-compact.ts: keep:N user-turn cuts,
 * token-budget tail rescue, orphan recovery via "" sentinel)
 */

import type { SessionEntry, SessionMessageEntry, CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimateMessageContentChars,
  estimateMessageContentTokens,
  estimateTokensFromChars,
} from "./token-estimate.js";
import type { BudgetCutKind } from "../types.js";

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      messages: AgentMessage[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

interface EntryWithMessage {
  entry: SessionEntry;
  message: AgentMessage;
}

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      content: undefined,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  return null;
};

export const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      const ce = branchEntries[i] as CompactionEntry;
      lastKeptId = ce.firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m as unknown as AgentMessage });
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m as unknown as AgentMessage });
    }
  }
  return liveMessages;
};

export function buildOwnCut(branchEntries: SessionEntry[], keepUserTurns = 1): OwnCutResult {
  const normalizedKeepUserTurns = Number.isFinite(keepUserTurns)
    ? Math.max(0, Math.floor(keepUserTurns))
    : 0;
  const liveMessages = collectLiveMessages(branchEntries);

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean): OwnCutResult => ({
    ok: true,
    messages: liveMessages.map((e) => e.message),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll: false,
  };
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, mirroring pi-core's findCutPoint.
export type BudgetCutKindLocal = BudgetCutKind;
export const OVERSIZED_TAIL_FACTOR = 2.5;

export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateMessageContentTokens((live[i].message as any).content, charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // Snap forward off any toolResult to the next valid boundary.
  for (let j = Math.max(crossed, 1); j < live.length; j++) {
    if (live[j].message.role !== "toolResult") return j;
  }
  return -1;
};

export interface TailBudgetOptions {
  maxTokens?: number;
  oversizedFactor?: number;
  charsPerToken?: number;
}

export const applyTailBudget = (
  branchEntries: SessionEntry[],
  cut: OwnCutResult,
  opts: TailBudgetOptions = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const live = collectLiveMessages(branchEntries);

  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx).map((m) => m.message),
    firstKeptEntryId: live[idx].entry.id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
    totalUserTurns: live.filter((m) => m.message.role === "user").length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0) return cut;
    return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageContentTokens((live[i].message as any).content, opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

// ── smart keep-tail: boost default keep when tail is small ──

export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

export interface ResolveSmartKeepOptions {
  branchEntries: SessionEntry[];
  /** Requested keep:N; null when user did not specify (default path). */
  requestedKeepUserTurns: number | null;
  /** True when user typed keep:N explicitly — always respected. */
  explicit: boolean;
  /** Setting toggle. */
  smartKeepTail: boolean;
  /** Injectable thresholds for tests. */
  minTokens?: number;
  maxTokens?: number;
  /** Calibrated chars/token for the current session; defaults to heuristic when omitted. */
  charsPerToken?: number;
}

export interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
  /** Original base keep, for toast like "1→3". */
  fromKeep: number;
}

/**
 * Estimate tail tokens for a given keep:N.
 * Returns null when keep would trigger compact-all (tail lost) or cancel,
 * so the resolver can stop growing instead of selecting a value that
 * discards the tail entirely.
 */
const tailTokensForKeep = (
  branchEntries: SessionEntry[],
  keepUserTurns: number,
  charsPerToken?: number,
): number | null => {
  const cut = buildOwnCut(branchEntries, keepUserTurns);
  if (!cut.ok || cut.compactAll) return null;
  const idx = branchEntries.findIndex((e: SessionEntry) => e.id === cut.firstKeptEntryId);
  if (idx < 0) return null;
  const kept = branchEntries.slice(idx).filter((e: SessionEntry): e is SessionMessageEntry =>
    e.type === "message",
  );
  const chars = kept.reduce(
    (sum: number, e: SessionMessageEntry) => sum + estimateMessageContentChars((e.message as any)?.content),
    0,
  );
  return estimateTokensFromChars(chars, charsPerToken);
};

/**
 * Resolve the effective keep:N.
 * - Explicit keep:N from the user is always respected.
 * - smartKeepTail=false → old behavior (default keep:1).
 * - smartKeepTail=true → if keep:1 tail <= minTokens, grow keep to the
 *   largest N whose tail stays <= maxTokens. Stops at compact-all boundary.
 */
export const resolveSmartKeepUserTurns = (opts: ResolveSmartKeepOptions): ResolveSmartKeepResult => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.explicit || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseTokens = tailTokensForKeep(opts.branchEntries, baseKeep, opts.charsPerToken);
  // base tail already above min (or unmeasurable / compact-all) → don't grow.
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseCut = buildOwnCut(opts.branchEntries, baseKeep);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts.branchEntries, k, opts.charsPerToken);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
    fromKeep: baseKeep,
  };
};
