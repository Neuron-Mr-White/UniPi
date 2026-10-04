/**
 * @pi-unipi/notify — Internal helper: build notification message from pi's
 * `ui_prompt_start` lifecycle payload.
 *
 * @internal — not part of the public API. Shared by the event listener and tests.
 */

/** Longest prompt title kept verbatim before an ellipsis is appended. */
export const INPUT_TITLE_MAX_CHARS = 120;

function cleanKind(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "prompt";
}

/** Truncate by code points (Array.from) so surrogate pairs are never split. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** Build a human-readable notification message from a ui_prompt_start payload. */
export function buildInputNeededMessage(payload: unknown): string {
  const p = (payload ?? {}) as { title?: unknown; kind?: unknown };
  const title = typeof p.title === "string" ? p.title.replace(/\s+/g, " ").trim() : "";
  if (title.length === 0) return `Waiting for your input (${cleanKind(p.kind)})`;
  return `Waiting for your input: ${truncate(title, INPUT_TITLE_MAX_CHARS)}`;
}
