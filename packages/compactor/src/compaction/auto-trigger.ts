/**
 * Pure percentage auto-compaction trigger decisions.
 *
 * The runtime wiring owns Pi ctx access; this module only decides whether a
 * known context-usage sample should trigger UniPi's zero-LLM compaction.
 */

import type { AutoCompactionConfig } from "../types.js";

export interface AutoCompactionUsage {
  tokens?: number | null;
  percent?: number | null;
  contextWindow?: number | null;
}

export interface KnownAutoCompactionUsage {
  tokens: number;
  percent: number;
  contextWindow?: number;
}

export interface AutoCompactionState {
  /** Previous known context percentage sample. Null before first known usage. */
  previousPercent: number | null;
  /** Previous known context token sample. Null before first known usage. */
  previousTokens: number | null;
  /** True after UniPi calls ctx.compact() and before Pi reports completion/error. */
  inFlight: boolean;
  /** Timestamp of the last UniPi-triggered compaction attempt. */
  lastTriggerAt: number | null;
  /** Context tokens reported at the last UniPi-triggered compaction attempt. */
  lastTriggerTokens: number | null;
  /** Baseline used to require meaningful token growth for repeat high-usage triggers. */
  repeatBaselineTokens: number | null;
  /** After a successful compaction, consume one known usage sample as a fresh baseline. */
  awaitingPostCompactionSample: boolean;
}

export type AutoCompactionDecisionReason =
  | "disabled"
  | "unknown_usage"
  | "in_flight"
  | "below_threshold"
  | "post_compaction_baseline"
  | "threshold_reached"
  | "threshold_crossed"
  | "cooldown_active"
  | "repeat_growth_needed"
  | "repeat_growth_reached";

export interface AutoCompactionDecision {
  shouldTrigger: boolean;
  reason: AutoCompactionDecisionReason;
  state: AutoCompactionState;
  thresholdPercent: number;
  usage?: KnownAutoCompactionUsage;
  cooldownRemainingMs?: number;
  tokenGrowth?: number;
  tokensUntilRepeat?: number;
}

export interface AutoCompactionDecisionInput {
  config?: Partial<AutoCompactionConfig> | null;
  usage?: AutoCompactionUsage | null;
  state: AutoCompactionState;
  nowMs?: number;
}

export const AUTO_COMPACTION_DEFAULTS: AutoCompactionConfig = {
  enabled: false,
  thresholdPercent: 80,
  cooldownMs: 60_000,
  repeatMinGrowthTokens: 4_000,
  notify: true,
};

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

export function normalizeAutoCompactionConfig(config?: Partial<AutoCompactionConfig> | null): AutoCompactionConfig {
  return {
    enabled: config?.enabled ?? AUTO_COMPACTION_DEFAULTS.enabled,
    thresholdPercent: clamp(
      config?.thresholdPercent,
      AUTO_COMPACTION_DEFAULTS.thresholdPercent,
      1,
      99,
    ),
    cooldownMs: Math.round(clamp(
      config?.cooldownMs,
      AUTO_COMPACTION_DEFAULTS.cooldownMs,
      0,
      24 * 60 * 60 * 1000,
    )),
    repeatMinGrowthTokens: Math.round(clamp(
      config?.repeatMinGrowthTokens,
      AUTO_COMPACTION_DEFAULTS.repeatMinGrowthTokens,
      0,
      10_000_000,
    )),
    notify: config?.notify ?? AUTO_COMPACTION_DEFAULTS.notify,
  };
}

export function createAutoCompactionState(): AutoCompactionState {
  return {
    previousPercent: null,
    previousTokens: null,
    inFlight: false,
    lastTriggerAt: null,
    lastTriggerTokens: null,
    repeatBaselineTokens: null,
    awaitingPostCompactionSample: false,
  };
}

function knownUsage(usage?: AutoCompactionUsage | null): KnownAutoCompactionUsage | null {
  if (!usage) return null;
  const { tokens, percent, contextWindow } = usage;
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return null;
  const known: KnownAutoCompactionUsage = { tokens, percent };
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    known.contextWindow = contextWindow;
  }
  return known;
}

function updatePrevious(state: AutoCompactionState, usage: KnownAutoCompactionUsage): AutoCompactionState {
  return {
    ...state,
    previousPercent: usage.percent,
    previousTokens: usage.tokens,
  };
}

function trigger(
  reason: Extract<AutoCompactionDecisionReason, "threshold_reached" | "threshold_crossed" | "repeat_growth_reached">,
  state: AutoCompactionState,
  usage: KnownAutoCompactionUsage,
  thresholdPercent: number,
  nowMs: number,
  tokenGrowth?: number,
): AutoCompactionDecision {
  return {
    shouldTrigger: true,
    reason,
    thresholdPercent,
    usage,
    tokenGrowth,
    state: {
      ...updatePrevious(state, usage),
      inFlight: true,
      lastTriggerAt: nowMs,
      lastTriggerTokens: usage.tokens,
      repeatBaselineTokens: usage.tokens,
      awaitingPostCompactionSample: false,
    },
  };
}

/**
 * Decide whether the current usage sample should trigger auto-compaction.
 *
 * Loop safeguards:
 * - unknown/null usage never triggers and does not erase the previous baseline;
 * - in-flight compactions suppress further triggers;
 * - every repeat trigger after a prior attempt observes cooldown;
 * - if usage remains above threshold after compaction, the first known sample is
 *   only a baseline, and a repeat requires sufficient token growth.
 */
export function decideAutoCompaction(input: AutoCompactionDecisionInput): AutoCompactionDecision {
  const config = normalizeAutoCompactionConfig(input.config);
  const nowMs = input.nowMs ?? Date.now();

  if (!config.enabled) {
    return {
      shouldTrigger: false,
      reason: "disabled",
      thresholdPercent: config.thresholdPercent,
      state: input.state,
    };
  }

  if (input.state.inFlight) {
    return {
      shouldTrigger: false,
      reason: "in_flight",
      thresholdPercent: config.thresholdPercent,
      state: input.state,
    };
  }

  const usage = knownUsage(input.usage);
  if (!usage) {
    return {
      shouldTrigger: false,
      reason: "unknown_usage",
      thresholdPercent: config.thresholdPercent,
      state: input.state,
    };
  }

  let nextState = updatePrevious(input.state, usage);

  if (input.state.awaitingPostCompactionSample) {
    nextState = {
      ...nextState,
      awaitingPostCompactionSample: false,
      repeatBaselineTokens: usage.percent >= config.thresholdPercent ? usage.tokens : null,
    };
    return {
      shouldTrigger: false,
      reason: usage.percent >= config.thresholdPercent ? "post_compaction_baseline" : "below_threshold",
      thresholdPercent: config.thresholdPercent,
      usage,
      state: nextState,
    };
  }

  if (usage.percent < config.thresholdPercent) {
    return {
      shouldTrigger: false,
      reason: "below_threshold",
      thresholdPercent: config.thresholdPercent,
      usage,
      state: {
        ...nextState,
        repeatBaselineTokens: null,
      },
    };
  }

  if (input.state.lastTriggerAt !== null) {
    const elapsedMs = Math.max(0, nowMs - input.state.lastTriggerAt);
    if (elapsedMs < config.cooldownMs) {
      return {
        shouldTrigger: false,
        reason: "cooldown_active",
        thresholdPercent: config.thresholdPercent,
        usage,
        cooldownRemainingMs: config.cooldownMs - elapsedMs,
        state: nextState,
      };
    }
  }

  const previousPercent = input.state.previousPercent;
  if (previousPercent === null) {
    return trigger("threshold_reached", input.state, usage, config.thresholdPercent, nowMs);
  }
  if (previousPercent < config.thresholdPercent) {
    return trigger("threshold_crossed", input.state, usage, config.thresholdPercent, nowMs);
  }

  // We were already above threshold. Re-trigger only after enough growth.
  if (input.state.lastTriggerAt === null) {
    return trigger("threshold_reached", input.state, usage, config.thresholdPercent, nowMs);
  }

  const baselineTokens = input.state.repeatBaselineTokens
    ?? input.state.lastTriggerTokens
    ?? input.state.previousTokens
    ?? usage.tokens;
  const tokenGrowth = Math.max(0, usage.tokens - baselineTokens);

  if (tokenGrowth < config.repeatMinGrowthTokens) {
    return {
      shouldTrigger: false,
      reason: "repeat_growth_needed",
      thresholdPercent: config.thresholdPercent,
      usage,
      tokenGrowth,
      tokensUntilRepeat: config.repeatMinGrowthTokens - tokenGrowth,
      state: nextState,
    };
  }

  return trigger(
    "repeat_growth_reached",
    input.state,
    usage,
    config.thresholdPercent,
    nowMs,
    tokenGrowth,
  );
}

export function markAutoCompactionComplete(state: AutoCompactionState): AutoCompactionState {
  return {
    ...state,
    inFlight: false,
    awaitingPostCompactionSample: true,
  };
}

export function markAutoCompactionError(state: AutoCompactionState, nowMs?: number): AutoCompactionState {
  return {
    ...state,
    inFlight: false,
    awaitingPostCompactionSample: false,
    lastTriggerAt: state.lastTriggerAt ?? nowMs ?? null,
  };
}
