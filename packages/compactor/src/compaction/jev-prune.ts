/**
 * jev pruning — the lossless summary asks TypeSafe jev (a calibrated
 * decision model, ~0.5s per call) which earlier items are no longer in force:
 * requests already done, decisions later reversed, errors since fixed, an
 * outdated progress report. Only confident drops are applied; everything
 * else stays. Fail-open: no key / timeout / bad answer → nothing is dropped.
 */

import { askJev, type JevSettings } from "@pi-unipi/core";

export interface PruneCandidate {
  key: string;
  kind: "request" | "decision" | "error" | "report";
  text: string;
}

/**
 * Drop only when jev is this sure. Decisions carry design choices that stay
 * true after the work is done, so they need near-certainty; a one-off request
 * or a fixed error needs less.
 */
export const DROP_PROBABILITY: Record<PruneCandidate["kind"], number> = {
  decision: 0.92,
  request: 0.8,
  error: 0.75,
  report: 0.7,
};
const BATCH = 20;
const STATE_CHARS = 6000;

const KIND_LABEL: Record<PruneCandidate["kind"], string> = {
  request: "Earlier user request",
  decision: "Earlier user decision or constraint",
  error: "Tool error seen earlier",
  report: "Earlier progress report",
};

function question(candidate: PruneCandidate) {
  return {
    type: "choice",
    instructions:
      `${KIND_LABEL[candidate.kind]}: ${candidate.text}\n` +
      "Is this still in force for the rest of the session, given the current state? Standing preferences, design decisions and constraints stay in force even when the current step is about something else.",
    criteria: {
      keep: "Still true: a standing preference, design decision, constraint, an unfinished request, or an unresolved problem — even if not about the current step.",
      drop: "No longer true: explicitly completed, fixed, reversed or replaced by later information, or a one-off action already carried out.",
    },
  };
}

export type JevAsk = typeof askJev;

/** Keys of candidates jev confidently marks as no longer in force. */
export async function pruneWithJev(
  candidates: readonly PruneCandidate[],
  state: string,
  settings: JevSettings,
  opts: { signal?: AbortSignal; ask?: JevAsk } = {},
): Promise<{ drop: Set<string>; asked: number; answered: number }> {
  const drop = new Set<string>();
  const ask = opts.ask ?? askJev;
  const clippedState = state.length > STATE_CHARS ? state.slice(state.length - STATE_CHARS) : state;
  let answered = 0;
  const batches: PruneCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      const questions = Object.fromEntries(batch.map((c, i) => [`q${i}`, question(c)]));
      const answers = await ask({ state: clippedState, questions, settings: { ...settings, timeoutMs: settings.timeoutMs || 15_000 }, signal: opts.signal });
      if (!answers) return;
      batch.forEach((c, i) => {
        const a = answers[`q${i}`] as { choice?: string; probabilities?: Record<string, number> } | undefined;
        if (!a) return;
        answered++;
        const pDrop = a.probabilities?.drop ?? (a.choice === "drop" ? 1 : 0);
        if (pDrop >= DROP_PROBABILITY[c.kind]) drop.add(c.key);
      });
    }),
  );
  return { drop, asked: candidates.length, answered };
}
