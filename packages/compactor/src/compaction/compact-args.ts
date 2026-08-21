/**
 * Parse keep:N and follow-up prompt from compaction custom instructions
 * (ported from pi-vcc compact-args.ts; marker constant stays ours: COMPACTOR_INSTRUCTION)
 */

import { COMPACTOR_INSTRUCTION } from "@pi-unipi/core";

const KEEP_TOKEN_RE = /^keep:(\d+)$/;

export interface ParsedCompactionArgs {
  followUpPrompt: string;
  keepUserTurns: number | null;
  keepUserTurnsExplicit: boolean;
}

const parseKeepUserTurns = (raw: string): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
};

export const parseKeepAndPrompt = (args?: string): ParsedCompactionArgs => {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { followUpPrompt: "", keepUserTurns: null, keepUserTurnsExplicit: false };

  const startMatch = trimmed.match(/^keep:(\d+)(?:\s+|$)([\s\S]*)$/);
  if (startMatch) {
    return {
      followUpPrompt: startMatch[2].trim(),
      keepUserTurns: parseKeepUserTurns(startMatch[1]),
      keepUserTurnsExplicit: true,
    };
  }

  const parts = trimmed.split(/\s+/);
  const endMatch = parts[parts.length - 1].match(KEEP_TOKEN_RE);
  if (endMatch) {
    return {
      followUpPrompt: trimmed.slice(0, trimmed.length - parts[parts.length - 1].length).trim(),
      keepUserTurns: parseKeepUserTurns(endMatch[1]),
      keepUserTurnsExplicit: true,
    };
  }

  return { followUpPrompt: trimmed, keepUserTurns: null, keepUserTurnsExplicit: false };
};

export interface ParsedCompactionInstructions {
  isCompactor: boolean;
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string | null;
}

/**
 * Parse customInstructions arriving at session_before_compact.
 * - Exactly COMPACTOR_INSTRUCTION → default path (keep 1, not explicit).
 * - COMPACTOR_INSTRUCTION + args → parse keep:N / prompt after the marker.
 * - Anything else → not ours (parse for a trailing keep:N anyway, pi-vcc parity).
 */
export const parseCompactionInstructions = (
  customInstructions?: string,
): ParsedCompactionInstructions => {
  const trimmed = customInstructions?.trim();
  if (trimmed === COMPACTOR_INSTRUCTION) {
    return { isCompactor: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  }

  const keepPrefix = `${COMPACTOR_INSTRUCTION} `;
  if (trimmed?.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      isCompactor: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: null,
    };
  }

  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    isCompactor: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};
