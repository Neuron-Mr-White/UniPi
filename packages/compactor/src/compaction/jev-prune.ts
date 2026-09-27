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
  kind: "request" | "decision" | "error" | "report" | "lesson" | "supersede";
  text: string;
  /** supersede: the earlier item; dropping means dropping it (its key). */
  earlier?: string;
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
  lesson: 0.8,
  supersede: 0.8,
};

/** Kinds judged on the item alone — jev sees no session state, only the question. */
const LOCAL_KINDS = new Set<PruneCandidate["kind"]>(["lesson", "supersede"]);
const LOCAL_STATE = "Items taken from a coding agent's session history. Judge each on its own text.";
const BATCH = 20;
const STATE_CHARS = 6000;

const KIND_LABEL: Record<PruneCandidate["kind"], string> = {
  request: "Earlier user request",
  decision: "Earlier user decision or constraint",
  error: "Tool error seen earlier",
  report: "Earlier progress report",
  lesson: "Note the agent wrote during the session",
  supersede: "",
};

function question(candidate: PruneCandidate) {
  if (candidate.kind === "lesson") {
    return {
      type: "choice",
      instructions: `${KIND_LABEL.lesson}: ${candidate.text}\nIs this a durable lesson about the project or its tools — something that would prevent a future mistake?`,
      criteria: {
        keep: "A reusable fact: how a tool, API, config or system behaves; a pitfall and its fix; a rule to follow.",
        drop: "A one-off status or progress note, a guess that was not confirmed, or a step-by-step narration.",
      },
    };
  }
  if (candidate.kind === "supersede") {
    return {
      type: "choice",
      instructions: `EARLIER: ${candidate.earlier}\nLATER: ${candidate.text}\nDoes LATER replace, reverse, or make EARLIER outdated?`,
      criteria: {
        drop: "Yes: LATER changes, reverts, corrects or supersedes what EARLIER says, so EARLIER is no longer true.",
        keep: "No: they are about different things, or LATER adds to EARLIER without contradicting it.",
      },
    };
  }
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
  const batches: Array<{ state: string; items: PruneCandidate[] }> = [];
  for (const local of [false, true]) {
    const group = candidates.filter((c) => LOCAL_KINDS.has(c.kind) === local);
    for (let i = 0; i < group.length; i += BATCH) batches.push({ state: local ? LOCAL_STATE : clippedState, items: group.slice(i, i + BATCH) });
  }
  await Promise.all(
    batches.map(async ({ state: batchState, items: batch }) => {
      const questions = Object.fromEntries(batch.map((c, i) => [`q${i}`, question(c)]));
      const answers = await ask({ state: batchState, questions, settings: { ...settings, timeoutMs: settings.timeoutMs || 15_000 }, signal: opts.signal });
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
