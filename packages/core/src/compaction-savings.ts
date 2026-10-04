/**
 * @pi-unipi/core — what compaction saved, from session entries.
 *
 * For every compaction:
 *   saved     = context before − context after
 *   replies   = assistant replies sent after it (until the next compaction)
 *   avoided   = saved × replies          tokens that were NOT re-sent
 *   rate      = Σ paid for context / Σ context tokens of those replies
 *               (input + cache read + cache write — the blended price the
 *               user actually paid per context token, so cache discounts
 *               are already in it)
 *   dollars   = avoided × rate           ≈ money not spent
 *
 * "after" is the compactor's own `details.tokensAfter` when present, else the
 * context size the first reply after the compaction actually reported — the
 * real number, not an estimate.
 *
 * Feed entries in file/branch order; works streaming (usage parser) or over
 * a branch array (info screen).
 */

export interface CompactionSaving {
  at: number;
  before: number;
  after: number;
  replies: number;
  /** Σ cost paid for context tokens by the replies after this compaction. */
  paid: number;
  /** Σ context tokens of those replies. */
  context: number;
}

export interface SavingsTotals {
  count: number;
  saved: number;
  avoided: number;
  dollars: number;
  /** Σ context actually sent after compactions (the "with" bar). */
  sent: number;
}

export class SavingsAccumulator {
  readonly items: CompactionSaving[] = [];
  private seen = new Set<string>();
  private open: CompactionSaving | null = null;
  private afterKnown = false;

  feed(entry: unknown): void {
    const e = entry as { type?: string; timestamp?: string; tokensBefore?: number; details?: { tokensAfter?: number }; message?: any };
    if (!e || typeof e !== "object") return;
    if (e.type === "compaction") {
      const at = Date.parse(e.timestamp ?? "") || 0;
      const before = Number(e.tokensBefore ?? 0);
      const key = `${at}:${before}`;
      // Forked session files copy history; count each compaction once.
      if (this.seen.has(key)) {
        this.open = null;
        return;
      }
      this.seen.add(key);
      const after = Number(e.details?.tokensAfter ?? 0);
      this.open = { at, before, after, replies: 0, paid: 0, context: 0 };
      this.afterKnown = after > 0;
      this.items.push(this.open);
      return;
    }
    if (e.type !== "message" || !this.open) return;
    const m = e.message;
    if (m?.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") return;
    const u = m.usage ?? {};
    const ctx = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (ctx <= 0) return;
    if (!this.afterKnown) {
      this.open.after = ctx;
      this.afterKnown = true;
    }
    this.open.replies++;
    this.open.context += ctx;
    const c = u.cost ?? {};
    this.open.paid += (c.input ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
  }

  totals(): SavingsTotals {
    return totalsOf(this.items);
  }
}

export function savedOf(c: CompactionSaving): number {
  return Math.max(0, c.before - (c.after || c.before));
}

export function avoidedOf(c: CompactionSaving): number {
  return savedOf(c) * c.replies;
}

export function dollarsOf(c: CompactionSaving): number {
  return c.context > 0 ? avoidedOf(c) * (c.paid / c.context) : 0;
}

export function totalsOf(items: readonly CompactionSaving[]): SavingsTotals {
  let saved = 0, avoided = 0, dollars = 0, sent = 0;
  for (const c of items) {
    saved += savedOf(c);
    avoided += avoidedOf(c);
    dollars += dollarsOf(c);
    sent += c.context;
  }
  return { count: items.length, saved, avoided, dollars, sent };
}

export function addTotals(a: SavingsTotals, b: SavingsTotals): SavingsTotals {
  return { count: a.count + b.count, saved: a.saved + b.saved, avoided: a.avoided + b.avoided, dollars: a.dollars + b.dollars, sent: a.sent + b.sent };
}

export const EMPTY_SAVINGS: SavingsTotals = { count: 0, saved: 0, avoided: 0, dollars: 0, sent: 0 };

/** Convenience: savings for a whole branch. */
export function compactionSavings(branch: readonly unknown[]): { items: CompactionSaving[]; totals: SavingsTotals } {
  const acc = new SavingsAccumulator();
  for (const e of branch) acc.feed(e);
  return { items: acc.items, totals: acc.totals() };
}
