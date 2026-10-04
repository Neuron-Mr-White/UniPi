/**
 * @pi-unipi/footer — Compaction summary
 *
 * Summarizes the session's compactions from the branch (pi's compaction
 * entries):
 *
 *   count, tokens before → after across all compactions, time since the last
 */

/** Tokens left after a compaction: our recorded estimate, else the summary size. */
function tokensAfterOf(entry: any, before: number): number {
  const recorded = Number(entry?.details?.tokensAfter ?? 0);
  if (recorded > 0) return Math.min(recorded, before);
  const summaryChars = typeof entry?.summary === "string" ? entry.summary.length : 0;
  return Math.min(before, Math.ceil(summaryChars / 4));
}

export function compactionSummary(branch: readonly any[], now = Date.now()): { count: number; before: number; after: number; lastAt?: number } {
  let count = 0;
  let before = 0;
  let after = 0;
  let lastAt: number | undefined;
  for (const e of branch) {
    if (e?.type !== "compaction") continue;
    count++;
    const b = Number(e.tokensBefore ?? 0);
    before += b;
    after += tokensAfterOf(e, b);
    const at = Date.parse(e.timestamp ?? "");
    if (Number.isFinite(at) && at <= now) lastAt = at;
  }
  return { count, before, after, ...(lastAt != null ? { lastAt } : {}) };
}
