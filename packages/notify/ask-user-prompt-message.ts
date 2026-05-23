/**
 * @pi-unipi/notify — Internal helper: build notification message from
 * ask-user prompt event payloads.
 *
 * Supports both UniPi's flat `unipi:ask-user:prompt` payload and the
 * lossless `rpiv:ask-user:prompt` questionnaire projection.
 *
 * @internal — not part of the public API. Shared by the event listener and tests.
 */

export interface AskUserPromptEventPayload {
  questions: ReadonlyArray<AskUserPromptQuestion>;
}

export interface AskUserPromptQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ReadonlyArray<AskUserPromptOption>;
}

export interface AskUserPromptOption {
  label: string;
  description: string;
  hasPreview: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function buildFlatPromptMessage(payload: Record<string, unknown>): string {
  const question = nonEmptyString(payload.question, "A question");
  const context = nonEmptyString(payload.context, "");
  return context ? `Agent asks: ${question} — ${context}` : `Agent asks: ${question}`;
}

/** Build a human-readable notification message from an ask-user prompt payload. */
export function buildAskUserPromptMessage(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};

  const questions = Array.isArray(p.questions)
    ? p.questions.filter(isRecord)
    : [];

  if (questions.length === 0 && ("question" in p || "context" in p)) {
    return buildFlatPromptMessage(p);
  }

  const firstQ = questions[0];

  const baseQuestion = firstQ
    ? nonEmptyString(firstQ.question, "A question")
    : "A question";

  const suffix = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";

  const optionLabels =
    firstQ && Array.isArray(firstQ.options)
      ? firstQ.options
          .filter(isRecord)
          .map((o) => nonEmptyString(o.label, ""))
          .filter((label) => label.length > 0)
      : [];

  const options = optionLabels.join(", ");

  return options
    ? `Agent asks: ${baseQuestion}${suffix} — ${options}`
    : `Agent asks: ${baseQuestion}${suffix}`;
}
