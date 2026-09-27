/**
 * Compaction hooks — every compaction (Pi's automatic ones, Pi's /compact,
 * UniPi's commands, the percentage trigger) goes through here and is routed
 * to one of two methods:
 *
 *   vcc  lossless zero-LLM summary (summarize.ts), rebuilt from full history
 *   llm  Pi's model-written summary, with the active-work block appended
 *
 * The percentage trigger compacts at `turn_end` by returning a compaction
 * draft — Pi applies it at the turn boundary without aborting the run, so
 * goal / ralph / kanboard loops keep going. Pi 0.87 already continues after
 * its own automatic compactions, so nothing here re-triggers the agent.
 */

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { compact as piCompact, generateSummaryWithUsage, DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { collectCompactionContext, emitEvent, formatTokens, resolveDecisionModel, UNIPI_EVENTS } from "@pi-unipi/core";
import { loadConfig } from "../config/manager.js";
import { autoCompactionOf } from "../config/schema.js";
import { buildOwnCut, resolveSmartKeepUserTurns, applyTailBudget, MAX_SMART_TAIL_TOKENS } from "./cut.js";
import { parseCompactionInstructions } from "./compact-args.js";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateTokensFromChars } from "./token-estimate.js";
import { collectSummarySource, ORIGIN_ENTRY_TYPE, originKey } from "./source.js";
import { autoBudgetTokens, buildLosslessSummary, pruneState, summaryCandidates, type LosslessSummaryInput, type SummaryCandidate } from "./summarize.js";
import { pruneWithJev } from "./jev-prune.js";
import {
  createAutoCompactionState,
  decideAutoCompaction,
  markAutoCompactionComplete,
  markAutoCompactionError,
  type AutoCompactionState,
} from "./auto-trigger.js";
import type { BudgetCutKind, CompactionMethod, CompactionStats, CompactorConfig, FileOps, RuntimeCounters } from "../types.js";

export const COMPACTOR_ID = "@pi-unipi/compactor";
const SUMMARY_CHARS_PER_TOKEN = 4;
/** Kept-tail sizing against the model window: recut above LIMIT, down to SHARE. */
const TAIL_WINDOW_LIMIT = 0.4;
const TAIL_WINDOW_SHARE = 0.25;

/** Custom types from the pre-rework compactor, still present in old sessions. */
const LEGACY_HIDDEN_TYPES = new Set(["compactor-auto-continue", "unipi-compactor-resume"]);

let lastStats: CompactionStats | null = null;
let pendingMethod: CompactionMethod | null = null;
let pendingFollowUpPrompt: string | null = null;
/** Set when a compaction was started by a UniPi command (it shows its own notice). */
let commandCompaction = false;

export const getLastCompactionStats = () => lastStats;

/** Route the next compaction to a method (used by /unipi:compact-vcc and -by-llm). */
export function setPendingCompaction(method: CompactionMethod | null, fromCommand = true): void {
  pendingMethod = method;
  commandCompaction = method !== null && fromCommand;
}

export const formatCompactionStats = (stats: CompactionStats): string => {
  const after = stats.tokensAfterEst != null ? ` → ~${formatTokens(stats.tokensAfterEst)}` : "";
  const before = stats.tokensBefore != null ? `${formatTokens(stats.tokensBefore)}${after} tok, ` : "";
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user turn to anchor on" : "oversized tail";
    return `compactor: ${before}kept ~${formatTokens(stats.keptTokensEst)} tok tail (${reason}), summarized ${stats.summarized}.`;
  }
  const notes = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) notes.push("smart-keep");
  return `compactor: ${before}kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns (${notes.join(", ")}).`;
};

const dbg = (debug: boolean, data: Record<string, unknown>) => {
  if (!debug) return;
  import("node:fs")
    .then(({ writeFileSync }) => writeFileSync("/tmp/compactor-debug.json", JSON.stringify(data, null, 2)))
    .catch(() => {});
};

const readReason = (event: unknown): "manual" | "threshold" | "overflow" | undefined => {
  const reason = (event as { reason?: unknown }).reason;
  return reason === "manual" || reason === "threshold" || reason === "overflow" ? reason : undefined;
};

const activeWorkText = (): string => {
  const blocks = collectCompactionContext();
  return blocks.length === 0 ? "" : `[Active Work]\n${blocks.map((b) => b.text).join("\n\n")}`;
};

// ── lossless plan ────────────────────────────────────────

export interface LosslessPlanInput {
  branchEntries: readonly any[];
  tokensBefore?: number;
  previousSummary?: string;
  fileOps?: FileOps;
  keepUserTurns?: number | null;
  keepExplicit?: boolean;
  /** The model's context window; the kept tail is sized to fit it. */
  contextWindow?: number;
  config: CompactorConfig;
  cwd?: string;
  reason?: string;
  /** Item keys to leave out of the summary (jev pruning). */
  drop?: ReadonlySet<string>;
  /** Receives the summary input before it is built (jev pruning reads it). */
  onSummaryInput?: (input: LosslessSummaryInput) => void;
}

export type LosslessPlan =
  | { ok: true; summary: string; firstKeptEntryId: string; details: Record<string, unknown>; stats: CompactionStats; messageCount: number }
  | { ok: false; reason: "no_live_messages" | "too_few_live_messages" };

/** Build a lossless compaction for the given branch (pure apart from active-work providers). */
export function planLosslessCompaction(input: LosslessPlanInput): LosslessPlan {
  const branch = input.branchEntries as any[];
  const { config } = input;
  const explicit = input.keepExplicit === true;

  // Calibrate chars/token from Pi's real token count vs the live message chars.
  const calibrationCut = buildOwnCut(branch, 0);
  const calibrationChars = calibrationCut.ok
    ? calibrationCut.messages.reduce((sum: number, m: any) => sum + estimateMessageContentChars(m.content), 0)
    : 0;
  const tokenEstimate = calibrateCharsPerToken(calibrationChars + (input.previousSummary?.length ?? 0), input.tokensBefore);
  const cpt = tokenEstimate.charsPerToken;

  const smartKeep = resolveSmartKeepUserTurns({
    branchEntries: branch,
    requestedKeepUserTurns: explicit ? (input.keepUserTurns ?? 1) : null,
    explicit,
    smartKeepTail: config.smartKeepTail,
    charsPerToken: cpt,
  });
  let cut = buildOwnCut(branch, smartKeep.keepUserTurns);
  if (cut.ok && !explicit) cut = applyTailBudget(branch, cut, { charsPerToken: cpt });
  // Whatever keep asked for, the tail must leave room for the system prompt,
  // the summary and the next turns: recut above 40% of the window (to 25%).
  if (cut.ok && input.contextWindow && input.contextWindow > 0) {
    cut = applyTailBudget(branch, cut, {
      charsPerToken: cpt,
      maxTokens: Math.floor(input.contextWindow * TAIL_WINDOW_SHARE),
      oversizedFactor: TAIL_WINDOW_LIMIT / TAIL_WINDOW_SHARE,
    });
  }
  if (!cut.ok) return { ok: false, reason: cut.reason };

  const keptIdx = cut.firstKeptEntryId ? branch.findIndex((e) => e.id === cut.firstKeptEntryId) : -1;
  const endIdx = keptIdx >= 0 ? keptIdx : branch.length;
  const keptChars = keptIdx >= 0
    ? branch.slice(keptIdx).reduce((sum, e) => sum + (e.type === "message" ? estimateMessageContentChars(e.message?.content) : 0), 0)
    : 0;
  const keptTokens = estimateTokensFromChars(keptChars, cpt);

  const source = collectSummarySource(branch, endIdx);
  const wanted = config.summaryBudgetTokens > 0 ? config.summaryBudgetTokens : autoBudgetTokens(source.blocks.length);
  // Small-context models: the summary may not crowd out the work (≤8% of the window).
  const budgetTokens = input.contextWindow && input.contextWindow > 0 ? Math.min(wanted, Math.max(800, Math.floor(input.contextWindow * 0.08))) : wanted;
  const summaryInput: LosslessSummaryInput = {
    source,
    activeWork: config.sections.activeWork ? collectCompactionContext() : [],
    // Summary text is plain prose: a fixed ratio, not the session's calibration
    // (which images and code skew).
    budgetChars: budgetTokens * SUMMARY_CHARS_PER_TOKEN,
    cwd: input.cwd,
    fileOps: input.fileOps,
    sections: config.sections,
    drop: input.drop,
  };
  input.onSummaryInput?.(summaryInput);
  const summary = buildLosslessSummary(summaryInput);

  const tokensAfter = keptTokens + estimateTokensFromChars(summary.text.length, SUMMARY_CHARS_PER_TOKEN);
  const keptMessages = keptIdx >= 0 ? branch.slice(keptIdx).filter((e) => e.type === "message").length : 0;
  const stats: CompactionStats = {
    summarized: cut.messages.length,
    kept: keptMessages,
    totalMessages: cut.messages.length + keptMessages,
    tokensBefore: input.tokensBefore,
    tokensAfterEst: tokensAfter,
    keptUserTurns: cut.keptUserTurns,
    totalUserTurns: cut.totalUserTurns,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepUserTurnsExplicit: explicit,
    keepFallbackToCompactAll: cut.keepFallbackToCompactAll,
    keptTokensEst: keptTokens,
    smartKeepAdjusted: smartKeep.smartAdjusted,
    smartFromKeep: smartKeep.fromKeep,
    budgetCut: cut.budgetCut as BudgetCutKind | undefined,
  };
  return {
    ok: true,
    summary: summary.text,
    firstKeptEntryId: cut.firstKeptEntryId,
    messageCount: cut.messages.length,
    stats,
    details: {
      compactor: COMPACTOR_ID,
      version: 2,
      method: "vcc",
      sections: summary.sections,
      sourceMessageCount: cut.messages.length,
      tokensAfter,
      budgetTokens,
      reason: input.reason,
      budgetCut: cut.budgetCut,
    },
  };
}

/**
 * Lossless compaction pruned by jev: build once to collect the candidates,
 * ask jev which are no longer in force, rebuild without them (their room goes
 * to other items). Falls back to the plain lossless plan when jev is silent.
 */
export async function planJevCompaction(
  input: LosslessPlanInput,
  prune: (candidates: SummaryCandidate[], state: string) => Promise<{ drop: Set<string>; asked: number; answered: number }>,
): Promise<LosslessPlan> {
  let captured: LosslessSummaryInput | null = null;
  const first = planLosslessCompaction({ ...input, onSummaryInput: (si) => (captured = si) });
  if (!first.ok || !captured) return first;
  const candidates = summaryCandidates(captured);
  if (candidates.length === 0) return withMethod(first, "jev", { asked: 0, dropped: 0 });
  const result = await prune(candidates, pruneState(captured));
  if (result.answered === 0) return withMethod(first, "jev", { asked: result.asked, dropped: 0, jev: "unavailable" });
  const plan = result.drop.size > 0 ? planLosslessCompaction({ ...input, drop: result.drop }) : first;
  return withMethod(plan, "jev", {
    asked: result.asked,
    dropped: result.drop.size,
    droppedItems: candidates.filter((c) => result.drop.has(c.key)).map((c) => `${c.kind}: ${(c.earlier ?? c.text).slice(0, 120)}`),
  });
}

function withMethod(plan: LosslessPlan, method: CompactionMethod, extra: Record<string, unknown>): LosslessPlan {
  return plan.ok ? { ...plan, details: { ...plan.details, method, jev: extra } } : plan;
}

/** jev pruning with the Decision Model (shared, or the compactor's custom override). */
export const jevPruner = (cwd: string, signal?: AbortSignal) => (candidates: SummaryCandidate[], state: string) =>
  pruneWithJev(candidates, state, resolveDecisionModel(cwd, "compactor"), { signal });

// ── model summary ────────────────────────────────────────

async function requestAuth(ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model) throw new Error("no model selected");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  return {
    model: auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
    apiKey: auth.apiKey,
    headers: auth.headers as Record<string, string> | undefined,
    env: auth.env,
  };
}

const joinInstructions = (...parts: Array<string | null | undefined>): string | undefined => {
  const text = parts.map((p) => p?.trim()).filter(Boolean).join("\n\n");
  return text || undefined;
};

const withActiveWork = (summary: string): string => {
  const active = activeWorkText();
  return active ? `${active}\n\n${summary}` : summary;
};

/** Pi's own summarizer over Pi's preparation, with active work prepended. */
async function llmFromPreparation(
  pi: ExtensionAPI,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  instructions: string | undefined,
) {
  const { model, apiKey, headers, env } = await requestAuth(ctx);
  const result = await piCompact(
    event.preparation,
    model,
    apiKey,
    headers,
    instructions,
    event.signal,
    pi.getThinkingLevel?.(),
    undefined,
    env,
  );
  return {
    summary: withActiveWork(result.summary),
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    usage: result.usage,
    details: { ...(result.details as object | undefined), compactor: COMPACTOR_ID, version: 2, method: "llm" },
  };
}

// ── registration ─────────────────────────────────────────

export interface CompactionHookDeps {
  counters: RuntimeCounters;
}

export function registerCompactionHooks(pi: ExtensionAPI, deps: CompactionHookDeps): void {
  let autoState: AutoCompactionState = createAutoCompactionState();

  const afterCompaction = (stats: CompactionStats | null, method: CompactionMethod) => {
    deps.counters.compactions++;
    emitEvent(pi, UNIPI_EVENTS.COMPACTOR_COMPACTED, {
      method,
      summarized: stats?.summarized ?? 0,
      kept: stats?.kept ?? 0,
      tokensBefore: stats?.tokensBefore ?? 0,
      tokensAfter: stats?.tokensAfterEst ?? 0,
      tokensSaved: Math.max(0, (stats?.tokensBefore ?? 0) - (stats?.tokensAfterEst ?? 0)),
    });
  };

  // Old sessions may still carry the removed auto-continue marker and the
  // (huge) continuity snapshot; neither belongs in the model's context.
  pi.on("context", (event) => {
    const messages = (event as { messages: Array<{ role?: string; customType?: string }> }).messages;
    const filtered = messages.filter((m) => m.role !== "custom" || !LEGACY_HIDDEN_TYPES.has(m.customType ?? ""));
    if (filtered.length !== messages.length) return { messages: filtered } as any;
  });

  // Mark user messages that extensions send, so summaries can tell them from
  // the user's own words (see source.ts).
  pi.on("input", (event) => {
    if (event.source !== "extension" || !event.text?.trim()) return;
    try {
      pi.appendEntry(ORIGIN_ENTRY_TYPE, { key: originKey(event.text) });
    } catch {
      // Never block input on bookkeeping.
    }
  });

  pi.on("session_start", () => {
    autoState = createAutoCompactionState();
    pendingMethod = null;
    commandCompaction = false;
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    const reason = readReason(event);
    const parsed = parseCompactionInstructions(event.customInstructions);
    const method: CompactionMethod = pendingMethod
      ?? (parsed.isCompactor
        ? (config.method === "jev" ? "jev" : "vcc")
        : reason === "manual" && config.piCompact !== "follow"
          ? config.piCompact
          : config.method);
    const fromCommand = pendingMethod !== null && commandCompaction;
    pendingMethod = null;
    pendingFollowUpPrompt = null;

    if (method === "llm") {
      const userInstructions = parsed.isCompactor ? undefined : event.customInstructions;
      try {
        const compaction = await llmFromPreparation(pi, event, ctx, joinInstructions(userInstructions, config.llmInstructions));
        lastStats = null;
        return { compaction };
      } catch (err) {
        if (event.signal?.aborted) return { cancel: true };
        // Fall back to Pi's own path (same summarizer, Pi's auth handling).
        dbg(config.debug, { method: "llm", fallback: true, error: String(err) });
        return;
      }
    }

    const planInput: LosslessPlanInput = {
      branchEntries: event.branchEntries as any[],
      tokensBefore: event.preparation.tokensBefore,
      previousSummary: event.preparation.previousSummary,
      fileOps: event.preparation.fileOps
        ? {
            readFiles: [...event.preparation.fileOps.read],
            modifiedFiles: [...event.preparation.fileOps.written, ...event.preparation.fileOps.edited],
          }
        : undefined,
      keepUserTurns: parsed.keepUserTurns,
      keepExplicit: parsed.keepUserTurnsExplicit,
      config,
      cwd,
      reason,
      contextWindow: ctx?.model?.contextWindow,
    };
    const plan = method === "jev"
      ? await planJevCompaction(planInput, jevPruner(cwd, event.signal))
      : planLosslessCompaction(planInput);

    if (!plan.ok) {
      // Overflow must still recover: let Pi's own summarizer handle it.
      if (reason === "overflow") return;
      if (reason === "manual" || fromCommand) {
        try {
          ctx?.ui?.notify?.(plan.reason === "no_live_messages" ? "compactor: nothing to compact" : "compactor: too few messages to compact", "warning");
        } catch {}
      }
      dbg(config.debug, { cancelled: true, reason: plan.reason });
      return { cancel: true };
    }

    lastStats = plan.stats;
    if (!parsed.isCompactor && parsed.followUpPrompt && reason === "manual") pendingFollowUpPrompt = parsed.followUpPrompt;
    dbg(config.debug, { method: "vcc", reason, stats: plan.stats, details: plan.details, summaryPreview: plan.summary.slice(0, 800) });
    return {
      compaction: {
        summary: plan.summary,
        details: plan.details,
        tokensBefore: event.preparation.tokensBefore,
        firstKeptEntryId: plan.firstKeptEntryId,
      },
    };
  });

  pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
    const details = (event.compactionEntry as { details?: { compactor?: string; method?: CompactionMethod } } | undefined)?.details;
    const ours = details?.compactor === COMPACTOR_ID;
    const method: CompactionMethod = !ours ? "llm" : details?.method === "llm" || details?.method === "jev" ? details.method : "vcc";
    afterCompaction(ours ? lastStats : null, method);

    const wasCommand = commandCompaction;
    commandCompaction = false;
    const followUp = pendingFollowUpPrompt;
    pendingFollowUpPrompt = null;
    if (!wasCommand && loadConfig(ctx?.cwd ?? process.cwd()).notify && ours && lastStats) {
      const stats = lastStats;
      setTimeout(() => {
        try {
          ctx?.ui?.notify?.(formatCompactionStats(stats), "info");
        } catch {}
      }, 300);
    }
    if (followUp) {
      setTimeout(() => {
        try {
          pi.sendUserMessage(followUp, { deliverAs: "followUp" });
        } catch {}
      }, 0);
    }
  });

  // Percentage trigger: compact at the turn boundary (no abort, loops continue).
  pi.on("turn_end", async (event, ctx) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const config = loadConfig(cwd);
    if (config.trigger !== "percent") return;
    if (event.outcome === "aborted") return;
    if (event.entries.some((draft) => draft.type === "compaction")) return;

    const decision = decideAutoCompaction({
      config: autoCompactionOf(config),
      usage: ctx.getContextUsage?.(),
      state: autoState,
      nowMs: Date.now(),
    });
    autoState = decision.state;
    if (!decision.shouldTrigger) return;

    const branch = ctx.sessionManager.getBranch() as any[];
    try {
      const draft = config.method === "llm"
        ? await boundaryLlmDraft(pi, ctx, branch, config)
        : await boundaryLosslessDraft(branch, config, cwd, decision.usage?.tokens, ctx.model?.contextWindow);
      if (!draft) {
        autoState = markAutoCompactionError(autoState, Date.now());
        return;
      }
      autoState = markAutoCompactionComplete(autoState);
      afterCompaction(draft.stats, config.method);
      if (config.notify && decision.usage) {
        const tail = draft.stats ? ` ${formatCompactionStats(draft.stats)}` : "";
        ctx.ui.notify(`Compacted at ${decision.usage.percent.toFixed(0)}% of context (threshold ${decision.thresholdPercent}%).${tail}`, "info");
      }
      return { entries: [draft.entry] };
    } catch (err) {
      autoState = markAutoCompactionError(autoState, Date.now());
      if (config.notify) ctx.ui.notify(`Auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }
  });
}

type BoundaryDraft = {
  entry: { type: "compaction"; summary: string; firstKeptEntryId: string | null; details?: unknown; usage?: any };
  stats: CompactionStats | null;
};

async function boundaryLosslessDraft(branch: any[], config: CompactorConfig, cwd: string, tokensBefore?: number, contextWindow?: number): Promise<BoundaryDraft | null> {
  const input: LosslessPlanInput = { branchEntries: branch, tokensBefore, config, cwd, reason: "percent", contextWindow };
  const plan = config.method === "jev" ? await planJevCompaction(input, jevPruner(cwd)) : planLosslessCompaction(input);
  if (!plan.ok) return null;
  lastStats = plan.stats;
  return {
    entry: { type: "compaction", summary: plan.summary, firstKeptEntryId: plan.firstKeptEntryId || null, details: plan.details },
    stats: plan.stats,
  };
}

async function boundaryLlmDraft(pi: ExtensionAPI, ctx: ExtensionContext, branch: any[], config: CompactorConfig): Promise<BoundaryDraft | null> {
  const cut = buildOwnCut(branch, 1);
  const tail = cut.ok ? applyTailBudget(branch, cut) : cut;
  if (!tail.ok || tail.messages.length === 0) return null;
  const previous = [...branch].reverse().find((e) => e.type === "compaction")?.summary as string | undefined;
  const { model, apiKey, headers, env } = await requestAuth(ctx);
  const result = await generateSummaryWithUsage(
    tail.messages as any,
    model,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    apiKey,
    headers,
    undefined,
    joinInstructions(config.llmInstructions),
    previous,
    pi.getThinkingLevel?.(),
    undefined,
    env,
  );
  lastStats = null;
  return {
    entry: {
      type: "compaction",
      summary: withActiveWork(result.text),
      firstKeptEntryId: tail.firstKeptEntryId || null,
      details: { compactor: COMPACTOR_ID, version: 2, method: "llm", reason: "percent" },
      usage: result.usage,
    },
    stats: null,
  };
}

export { MAX_SMART_TAIL_TOKENS };
