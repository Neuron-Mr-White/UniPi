/**
 * @pi-unipi/utility — Auto-rename gate
 *
 * Decides, after a confirmed round, whether the session deserves a (new) name:
 *   1. Cheap prefilter: greetings, thanks, "ok", "continue" never rename.
 *   2. jev, two local questions with no session history:
 *        request — is this a real request with its own subject matter?
 *        topic   — (only when named) does it leave the current name's topic?
 *   3. jev unavailable → rename only an unnamed session on a ≥4-word prompt.
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
}

export function gateRequest(input: GateInput): { state: string; questions: Record<string, unknown> } {
  const earlier = input.earlier.filter((e) => e !== input.prompt).slice(-3);
  const state = [
    `Latest user message:\n${input.prompt.slice(0, 1500)}`,
    earlier.length ? `Earlier user messages:\n${earlier.map((e) => `- ${e.slice(0, 200)}`).join("\n")}` : "",
    input.currentName ? `Current session title: "${input.currentName}"` : "The session has no title yet.",
  ].filter(Boolean).join("\n\n");
  const questions: Record<string, unknown> = {
    request: {
      type: "choice",
      instructions: "Does the latest user message carry a task or subject of its own that a session title could describe?",
      criteria: {
        task: "It asks for work, a change, an answer or an investigation and names what it is about.",
        chatter: "A greeting, thanks, acknowledgement, approval (yes / ok / go on), or a bare 'continue' with no subject of its own.",
      },
    },
  };
  if (input.currentName) {
    questions.topic = {
      type: "choice",
      instructions: `Does the latest user message move to a different task than the current title "${input.currentName}"?`,
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

export function decide(input: GateInput, answers: Record<string, JevAnswer> | null): GateDecision {
  if (isChatter(input.prompt)) return { rename: false, reason: "chatter" };
  if (!answers) {
    if (input.currentName) return { rename: false, reason: "jev unavailable; keeping current name" };
    return wordCount(input.prompt) >= 4
      ? { rename: true, reason: "jev unavailable; first substantive prompt" }
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
