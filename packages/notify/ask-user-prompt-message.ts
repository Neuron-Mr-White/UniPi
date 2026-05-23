/**
 * @pi-unipi/notify — Internal helper: build notification message from
 * rpiv:ask-user:prompt event payload.
 *
 * @internal — not part of the public API. Shared by the event listener and tests.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

/**
 * Build a human-readable notification message from an rpiv:ask-user:prompt
 * payload (lossless format).
 */
export function buildAskUserPromptMessage(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};

  const questions = Array.isArray(p.questions)
    ? p.questions.filter(isRecord)
    : [];

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
