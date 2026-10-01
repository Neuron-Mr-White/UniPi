import { describe, expect, it } from "bun:test";
import { cardDetails, cardHeadline, renderCompactionCard } from "../src/card.js";
import { buildCardData } from "../src/compaction/hooks.js";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const stats = {
  summarized: 11, kept: 3, totalMessages: 14, tokensBefore: 9131, tokensAfterEst: 655,
  keptUserTurns: 1, totalUserTurns: 2, requestedKeepUserTurns: 1, keepUserTurnsExplicit: false,
  keepFallbackToCompactAll: false, keptTokensEst: 400, smartKeepAdjusted: false, smartFromKeep: 1,
} as any;

describe("compaction card", () => {
  const card = buildCardData({
    method: "vcc",
    trigger: "percent",
    tokensBefore: 9131,
    stats,
    details: { sections: ["Active Work", "Your Requests"] },
    summary: "x".repeat(1000),
    percent: 12.4,
    threshold: 3,
  });

  it("one plain line: sizes, method, outcome, trigger", () => {
    expect(cardHeadline(card)).toBe("Compacted 9.1k → 655 tokens · lossless · at 12%");
    const manual = buildCardData({ method: "vcc", trigger: "manual", tokensBefore: 40000, stats, details: null, command: "unipi:compact-vcc" });
    expect(cardHeadline(manual)).toContain("· lossless · /unipi:compact-vcc");
    const pi = buildCardData({ method: "llm", trigger: "threshold", tokensBefore: 120000, stats: null, details: null, summary: "y".repeat(8000) });
    expect(cardHeadline(pi)).toBe("Compacted from 120k tokens · model summary · context limit");
  });

  it("details on expand: trigger, kept, summary, recall", () => {
    const rows = Object.fromEntries(cardDetails(card).filter(([l]) => l));
    expect(rows.Method).toBe("lossless");
    expect(rows.Trigger).toBe("12% of context (setting: 3%)");
    expect(rows.Kept).toBe("last 1 of 2 turns · ~400 tokens verbatim");
    expect(rows.Summary).toBe("~250 tokens · Active Work, Your Requests");
    expect(rows.Recall).toContain("/unipi:session-recall");
  });

  it("collapsed renders one line with the ctrl+o hint; expanded adds the details", () => {
    const collapsed = renderCompactionCard(card, false, theme).render(120);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("ctrl+o");
    expect(renderCompactionCard(card, true, theme).render(120).length).toBeGreaterThan(5);
  });
});
