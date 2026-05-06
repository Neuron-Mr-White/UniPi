/**
 * @pi-unipi/ask-user — new_session handoff helpers
 *
 * Queues launcher prefill messages without waiting for LLM follow-up.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { SessionLaunchReason, SessionLaunchStatus } from "./types.js";

/** Compact handoff fallback timer. Keeps the launcher from stalling if callbacks wait for the tool turn to finish. */
export const COMPACT_HANDOFF_FALLBACK_MS = 1500;

export interface HandoffResult {
  status: SessionLaunchStatus;
  reason: SessionLaunchReason;
  prefill?: string;
  error?: string;
}

interface NormalizedPrefill {
  ok: true;
  prefill: string;
} 

interface InvalidPrefill {
  ok: false;
  reason: "empty-prefill";
}

function normalizePrefill(prefill: string | undefined): NormalizedPrefill | InvalidPrefill {
  const trimmed = (prefill ?? "").trim();
  if (!trimmed) {
    return { ok: false, reason: "empty-prefill" };
  }
  return { ok: true, prefill: trimmed };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // Notifications are best-effort only; never let status UI break delivery.
  }
}

function fallbackToEditor(
  ctx: ExtensionContext,
  prefill: string,
  reason: SessionLaunchReason,
  error: unknown,
): HandoffResult {
  try {
    ctx.ui.setEditorText(prefill);
    notify(ctx, "Automatic handoff failed. The command was placed in the editor; press Enter to run it.", "warning");
    return {
      status: "editor_prefill",
      reason,
      prefill,
      error: errorMessage(error),
    };
  } catch (editorError) {
    notify(ctx, `Automatic handoff failed and editor fallback failed: ${errorMessage(editorError)}`, "error");
    return {
      status: "failed",
      reason,
      prefill,
      error: `${errorMessage(error)}; editor fallback: ${errorMessage(editorError)}`,
    };
  }
}

function deliverFollowUpMessage(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prefill: string,
  reason: SessionLaunchReason,
): HandoffResult {
  try {
    pi.sendUserMessage(prefill, { deliverAs: "followUp" });
    return { status: "queued", reason, prefill };
  } catch (error) {
    return fallbackToEditor(ctx, prefill, reason, error);
  }
}

export function queueDirectHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prefill: string | undefined,
): HandoffResult {
  const normalized = normalizePrefill(prefill);
  if (!normalized.ok) {
    return { status: "cancelled", reason: normalized.reason };
  }

  return deliverFollowUpMessage(pi, ctx, normalized.prefill, "direct");
}

export function queueCompactHandoff(params: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  prefill: string | undefined;
  customInstructions: string;
}): HandoffResult {
  const { pi, ctx, customInstructions } = params;
  const normalized = normalizePrefill(params.prefill);
  if (!normalized.ok) {
    return { status: "cancelled", reason: normalized.reason };
  }

  const { prefill } = normalized;
  let delivered = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFallbackTimer = () => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
  };

  const deliverOnce = (reason: SessionLaunchReason): HandoffResult | undefined => {
    if (delivered) {
      return undefined;
    }
    delivered = true;
    clearFallbackTimer();
    if (reason === "fallback-timeout") {
      notify(ctx, "Compaction is still running; queued the selected handoff command via fallback.", "info");
    }
    return deliverFollowUpMessage(pi, ctx, prefill, reason);
  };

  fallbackTimer = setTimeout(() => {
    deliverOnce("fallback-timeout");
  }, COMPACT_HANDOFF_FALLBACK_MS);

  try {
    ctx.compact({
      customInstructions,
      onComplete: () => {
        deliverOnce("compacted");
      },
      onError: (error) => {
        notify(ctx, `Compaction reported an error; continuing handoff anyway: ${errorMessage(error)}`, "warning");
        deliverOnce("compaction-error");
      },
    });
  } catch (error) {
    notify(ctx, `Could not start compaction; running selected handoff directly: ${errorMessage(error)}`, "warning");
    return deliverOnce("compact-start-failed") ?? {
      status: "queued",
      reason: "compact-start-failed",
      prefill,
    };
  }

  return { status: "scheduled", reason: "compact-started", prefill };
}
