/**
 * @pi-unipi/notify — Internal helper: build notification message from
 * Pi-native `ui_prompt_start` event payloads.
 *
 * Pi (0.84.4+) emits `ui_prompt_start` whenever an extension's
 * `ctx.ui.select/confirm/input/editor/custom` starts waiting on the user.
 * `custom` prompts carry no title. A title may come from model output, so it
 * is sanitized before it reaches a desktop or push notification.
 *
 * @internal — not part of the public API. Shared by the event listener and tests.
 */

export type UIPromptKind = "select" | "confirm" | "input" | "editor" | "custom";

/** Mirrors Pi's `UIPromptStartEvent` (kept local: the pinned Pi types predate it). */
export interface UIPromptEventPayload {
  type: "ui_prompt_start";
  reason: "ui_prompt";
  kind: UIPromptKind;
  title?: string;
}

/** Longest prompt title kept in a notification, in code points. */
export const UI_PROMPT_TITLE_MAX = 200;

const FALLBACK = "Pi is waiting for your input.";

// Runs of whitespace and C0/C1 control characters, DEL included (terminal
// escapes, bells, newlines), collapsed to one space in a single pass.
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f-\u009f]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Strip control characters, collapse whitespace, and cap the length. */
function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_OR_SPACE, " ").trim();
  if (cleaned.length === 0) return undefined;
  // Count code points, not UTF-16 units, so a cut never splits a surrogate pair.
  const chars = Array.from(cleaned);
  return chars.length > UI_PROMPT_TITLE_MAX
    ? `${chars.slice(0, UI_PROMPT_TITLE_MAX - 1).join("")}…`
    : cleaned;
}

/** Build a human-readable notification message from a `ui_prompt_start` payload. */
export function buildUIPromptMessage(payload: unknown): string {
  const title = cleanTitle(isRecord(payload) ? payload.title : undefined);
  return title ? `Pi is waiting for your input: ${title}` : FALLBACK;
}
