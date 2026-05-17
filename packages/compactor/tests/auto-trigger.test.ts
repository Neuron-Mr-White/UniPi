import { describe, expect, it } from "bun:test";
import {
  createAutoCompactionState,
  decideAutoCompaction,
  markAutoCompactionComplete,
  type AutoCompactionState,
} from "../src/compaction/auto-trigger.js";
import type { AutoCompactionConfig } from "../src/types.js";

const config: AutoCompactionConfig = {
  enabled: true,
  thresholdPercent: 80,
  cooldownMs: 1_000,
  repeatMinGrowthTokens: 500,
  notify: true,
};

const usage = (tokens: number | null, percent: number | null) => ({
  tokens,
  percent,
  contextWindow: 10_000,
});

function decide(state: AutoCompactionState, tokens: number | null, percent: number | null, nowMs = 0) {
  return decideAutoCompaction({ config, state, usage: usage(tokens, percent), nowMs });
}

describe("auto-compaction trigger", () => {
  it("does not trigger when disabled", () => {
    const state = createAutoCompactionState();
    const decision = decideAutoCompaction({
      config: { ...config, enabled: false },
      state,
      usage: usage(9_000, 90),
      nowMs: 0,
    });

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toBe("disabled");
    expect(decision.state).toEqual(state);
  });

  it("ignores unknown post-compaction usage", () => {
    const state = createAutoCompactionState();
    const decision = decide(state, null, null);

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toBe("unknown_usage");
    expect(decision.state.previousPercent).toBeNull();
  });

  it("tracks below-threshold samples without triggering", () => {
    const state = createAutoCompactionState();
    const decision = decide(state, 7_000, 70);

    expect(decision.shouldTrigger).toBe(false);
    expect(decision.reason).toBe("below_threshold");
    expect(decision.state.previousPercent).toBe(70);
    expect(decision.state.previousTokens).toBe(7_000);
  });

  it("triggers on first known sample already above threshold", () => {
    const state = createAutoCompactionState();
    const decision = decide(state, 8_000, 80, 100);

    expect(decision.shouldTrigger).toBe(true);
    expect(decision.reason).toBe("threshold_reached");
    expect(decision.state.inFlight).toBe(true);
    expect(decision.state.lastTriggerAt).toBe(100);
  });

  it("triggers when crossing from below to at-or-above threshold", () => {
    const below = decide(createAutoCompactionState(), 7_900, 79, 0);
    const crossed = decide(below.state, 8_100, 81, 100);

    expect(crossed.shouldTrigger).toBe(true);
    expect(crossed.reason).toBe("threshold_crossed");
  });

  it("does not trigger while compaction is in flight", () => {
    const triggered = decide(createAutoCompactionState(), 8_100, 81, 100);
    const again = decide(triggered.state, 8_200, 82, 200);

    expect(again.shouldTrigger).toBe(false);
    expect(again.reason).toBe("in_flight");
  });

  it("uses the first known sample after completion as a high-usage baseline", () => {
    const triggered = decide(createAutoCompactionState(), 8_100, 81, 100);
    const completed = markAutoCompactionComplete(triggered.state);
    const unknown = decide(completed, null, null, 200);
    const baseline = decide(unknown.state, 8_200, 82, 300);

    expect(unknown.reason).toBe("unknown_usage");
    expect(baseline.shouldTrigger).toBe(false);
    expect(baseline.reason).toBe("post_compaction_baseline");
    expect(baseline.state.repeatBaselineTokens).toBe(8_200);
  });

  it("does not repeat during cooldown", () => {
    const triggered = decide(createAutoCompactionState(), 8_100, 81, 100);
    const completed = markAutoCompactionComplete(triggered.state);
    const baseline = decide(completed, 8_200, 82, 200);
    const repeat = decide(baseline.state, 9_000, 90, 500);

    expect(repeat.shouldTrigger).toBe(false);
    expect(repeat.reason).toBe("cooldown_active");
    expect(repeat.cooldownRemainingMs).toBe(600);
  });

  it("does not repeat after cooldown without enough token growth", () => {
    const triggered = decide(createAutoCompactionState(), 8_100, 81, 100);
    const completed = markAutoCompactionComplete(triggered.state);
    const baseline = decide(completed, 8_200, 82, 200);
    const repeat = decide(baseline.state, 8_600, 86, 1_200);

    expect(repeat.shouldTrigger).toBe(false);
    expect(repeat.reason).toBe("repeat_growth_needed");
    expect(repeat.tokenGrowth).toBe(400);
    expect(repeat.tokensUntilRepeat).toBe(100);
  });

  it("repeats after cooldown and sufficient token growth", () => {
    const triggered = decide(createAutoCompactionState(), 8_100, 81, 100);
    const completed = markAutoCompactionComplete(triggered.state);
    const baseline = decide(completed, 8_200, 82, 200);
    const repeat = decide(baseline.state, 8_800, 88, 1_200);

    expect(repeat.shouldTrigger).toBe(true);
    expect(repeat.reason).toBe("repeat_growth_reached");
    expect(repeat.tokenGrowth).toBe(600);
  });

  it("can trigger again from a fresh below-threshold baseline", () => {
    const first = decide(createAutoCompactionState(), 8_100, 81, 100);
    const completed = markAutoCompactionComplete(first.state);
    const below = decide(completed, 4_000, 40, 200);
    const second = decide(below.state, 8_050, 80.5, 1_200);

    expect(below.reason).toBe("below_threshold");
    expect(second.shouldTrigger).toBe(true);
    expect(second.reason).toBe("threshold_crossed");
  });
});
