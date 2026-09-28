/**
 * @pi-unipi/utility — Auto-rename gate
 *
 * Decides, after a confirmed round, whether the session deserves a (new) name.
 * It judges the ROUND — the user's message AND what the agent did with it — so
 * a vague opener ("hi, let's look at what we have") that turns into real work
 * still names the session:
 *   1. Cheap prefilter: a bare greeting/thanks/"ok" round with no tool work never renames.
 *   2. jev, two local questions:
 *        request — did the round establish a subject a title could describe?
 *        topic   — (only when named) did it move to a different task?
 *   3. jev unavailable → rename only an unnamed session after a round with
 *      real work (tool calls) or a ≥4-word prompt.
 */

import { isChatter, type JevAnswer } from "@pi-unipi/core";

export { isChatter };

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export interface GateInput {
  prompt: string;
  currentName: string | null;
  earlier: readonly string[];
  /** The agent's final reply this round (trimmed). */
  reply?: string;
  /** Tool calls the agent made this round. */
  toolCalls?: number;
}

/** A round with this many tool calls did real work, whatever the prompt said. */
export const WORK_TOOL_CALLS = 2;

export function gateRequest(input: GateInput): { state: string; questions: Record<string, unknown> } {
  const earlier = input.earlier.filter((e) => e !== input.prompt).slice(-3);
  const state = [
    `Latest user message:\n${input.prompt.slice(0, 1500)}`,
    earlier.length ? `Earlier user messages:\n${earlier.map((e) => `- ${e.slice(0, 200)}`).join("\n")}` : "",
    input.reply ? `Assistant's reply this round (${input.toolCalls ?? 0} tool calls):\n${input.reply.slice(0, 1200)}` : "",
    input.currentName ? `Current session title: "${input.currentName}"` : "The session has no title yet.",
  ].filter(Boolean).join("\n\n");
  const questions: Record<string, unknown> = {
    request: {
      type: "choice",
      instructions: "Did this round (the latest user message together with the assistant's reply) establish a task or subject that a session title could describe?",
      criteria: {
        task: "The user asked for work, a change, an answer, a review or an investigation — or opened loosely and the assistant's reply shows real work on a definite subject.",
        chatter: "Only small talk: a greeting, thanks, acknowledgement, approval (yes / ok / go on) or a bare 'continue', and the reply adds no subject of its own.",
      },
    },
  };
  if (input.currentName) {
    questions.topic = {
      type: "choice",
      instructions: `Does this round move to a different task than the current title "${input.currentName}"?`,
      criteria: {
        same: "Same task or area: a follow-up, refinement, fix or next step of what the title describes.",
        new: "A different task, feature or subject that the current title no longer describes.",
      },
    };
  }
  return { state, questions };
}

export const REQUEST_CONFIDENCE = 0.6;
export const TOPIC_CONFIDENCE = 0.7;

export type GateDecision = { rename: true; reason: string } | { rename: false; reason: string };

/** Rounds that can never name a session, decided without jev. */
export function isIdleRound(input: GateInput): boolean {
  return isChatter(input.prompt) && (input.toolCalls ?? 0) < WORK_TOOL_CALLS;
}

export function decide(input: GateInput, answers: Record<string, JevAnswer> | null): GateDecision {
  if (isIdleRound(input)) return { rename: false, reason: "chatter" };
  if (!answers) {
    if (input.currentName) return { rename: false, reason: "jev unavailable; keeping current name" };
    return wordCount(input.prompt) >= 4 || (input.toolCalls ?? 0) >= WORK_TOOL_CALLS
      ? { rename: true, reason: "jev unavailable; first substantive round" }
      : { rename: false, reason: "jev unavailable; prompt too short" };
  }
  const req = answers.request;
  if (req?.choice !== "task" || (req.confidence ?? 0) < REQUEST_CONFIDENCE) {
    return { rename: false, reason: `not a request (${req?.choice ?? "?"} ${(req?.confidence ?? 0).toFixed(2)})` };
  }
  if (!input.currentName) return { rename: true, reason: "first request" };
  const topic = answers.topic;
  if (topic?.choice === "new" && (topic.confidence ?? 0) >= TOPIC_CONFIDENCE) {
    return { rename: true, reason: `topic changed (${(topic.confidence ?? 0).toFixed(2)})` };
  }
  return { rename: false, reason: `same topic (${topic?.choice ?? "?"} ${(topic?.confidence ?? 0).toFixed(2)})` };
}

/** Clean a model-proposed title: one line, no quotes, ≤ 6 words / 60 chars. */
export function sanitizeName(raw: string): string {
  const line = raw.split("\n")[0]!.replace(/^["'`*#\s]+|["'`*\s.]+$/g, "").replace(/\s+/g, " ").trim();
  return line.split(" ").slice(0, 6).join(" ").slice(0, 60).trim();
}
