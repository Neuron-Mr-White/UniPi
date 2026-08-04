/**
 * @pi-unipi/notify — Internal helper: build notification message from
 * permission prompt event payloads.
 *
 * Handles the `permissions:ui_prompt` broadcast emitted by
 * `@gotgenes/pi-permission-system` immediately before a human-facing
 * permission prompt is shown.
 *
 * @internal — not part of the public API. Shared by the event listener and tests.
 */

export interface PermissionPromptEventPayload {
  /** Correlation id for the permission request */
  requestId?: string;
  /** Originating subsystem of the request */
  source?: string;
  /** Surface being requested — e.g. "bash", "mcp", "read", "edit" */
  surface?: string | null;
  /** Command / path / tool / skill being requested */
  value?: string | null;
  /** Current or requesting agent, when available */
  agentName?: string | null;
  /** Human-readable permission prompt text */
  message?: string;
  /** Present for forwarded subagent prompts */
  forwarding?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Return a trimmed non-empty string, or `undefined` for anything else. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `forwarding` is documented as "present for forwarded subagent prompts".
 * Treat an explicitly falsy value (false / null / "" / 0) as not forwarded so
 * that publishers which always include the key are handled correctly.
 */
function isForwarded(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * Build the "what was requested" clause from `agentName` / `surface` / `value`.
 * Returns `undefined` when there is nothing meaningful to say.
 */
function buildRequestClause(
  agentName: string | undefined,
  surface: string | undefined,
  value: string | undefined,
): string | undefined {
  if (!surface && !value) return undefined;

  const who = agentName ?? "Agent";

  if (surface && value) return `${who} requested ${surface} '${value}'.`;
  if (surface) return `${who} requested ${surface} access.`;
  return `${who} requested '${value}'.`;
}

/** Build a human-readable notification message from a permission prompt payload. */
export function buildPermissionPromptMessage(payload: unknown): string {
  const p = isRecord(payload) ? payload : {};

  const agentName = cleanString(p.agentName);
  const surface = cleanString(p.surface);
  const value = cleanString(p.value);
  const message = cleanString(p.message);

  const parts: string[] = [];

  const requestClause = buildRequestClause(agentName, surface, value);
  if (requestClause) parts.push(requestClause);

  // Only append the prompt text when it adds information beyond the clause.
  if (message && message !== requestClause) parts.push(message);

  if (parts.length === 0) parts.push("Pi is waiting for a permission decision.");

  if (isForwarded(p.forwarding)) parts.push("(forwarded)");

  return parts.join(" ");
}
