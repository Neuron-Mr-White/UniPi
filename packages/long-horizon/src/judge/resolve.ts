/**
 * Mode resolution — the ladder the gate runs at every turn admission.
 *
 *   1. explicit /unipi:<mode> override (the gate parses commands; passes it in)
 *   2. active automation owner → its mode (judge skipped entirely)
 *   3. judge enabled + configured + NEW user message → TypeSafe Choice,
 *      confidence-gated; low confidence abstains to owner/default
 *   4. default mode (settings; goal when judge is off)
 *
 * The judge never overrides an active owner, and never blocks a turn: every
 * failure path resolves to a concrete mode.
 *
 * Design: docs/long-horizon-design.md §1–§2.
 */

import { createHash } from "node:crypto";
import { askJudge, createJudgeTransport, type FetchLike, type JudgeTransport } from "./typesafe.js";
import type { LhMode } from "../modes.js";
import { modeForOwnerKind } from "../modes.js";
import type { LongHorizonSettings } from "../settings.js";
import type { OwnerState } from "../owner.js";

export type ResolutionSource =
  | "explicit"
  | "owner"
  | "judge"
  | "judge_abstained_low_confidence"
  | "default";

export interface Resolution {
  readonly mode: LhMode;
  readonly source: ResolutionSource;
  /** Set when the judge produced an answer (even an abstained one). */
  readonly confidence?: number;
}

export interface ResolveDeps {
  readonly settings: LongHorizonSettings;
  readonly activeOwner?: OwnerState;
  /** Explicit mode from a /unipi:<mode> command, if present. */
  readonly explicit?: LhMode;
  /** The new user message; omit for continuations/wakes/recovery (judge skipped). */
  readonly prompt?: string;
  readonly transport?: JudgeTransport;
  readonly fetchImpl?: FetchLike;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
}

/** Single-entry cache: identical consecutive prompts don't pay twice. */
const CACHE_TTL_MS = 10_000;
let cacheEntry: { hash: string; answer: { mode: LhMode; confidence: number }; at: number } | null =
  null;

export function resetJudgeCache(): void {
  cacheEntry = null;
}

function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

async function consultJudge(
  deps: ResolveDeps,
  prompt: string,
): Promise<{ mode: LhMode; confidence: number } | null> {
  const now = deps.now?.() ?? Date.now();
  const hash = promptHash(prompt);
  if (cacheEntry && cacheEntry.hash === hash && now - cacheEntry.at < CACHE_TTL_MS) {
    return cacheEntry.answer;
  }

  const settings = deps.settings;
  const hasKey =
    settings.judge.provider === "typesafe"
      ? Boolean((deps.env ?? process.env).TYPESAFE_API_KEY)
      : Boolean((deps.env ?? process.env).OPENROUTER_API_KEY);
  if (!settings.judge.enabled || !hasKey) return null;

  const transport =
    deps.transport ??
    createJudgeTransport({ settings: settings.judge, fetchImpl: deps.fetchImpl, env: deps.env });
  const answer = await askJudge(transport, prompt);
  if (answer) cacheEntry = { hash, answer, at: now };
  return answer;
}

export async function resolveMode(deps: ResolveDeps): Promise<Resolution> {
  // 1. Explicit wins over everything.
  if (deps.explicit) return { mode: deps.explicit, source: "explicit" };

  // 2. An active owner keeps its mode; its prompts are steering, not switching.
  if (deps.activeOwner) return { mode: modeForOwnerKind(deps.activeOwner.kind), source: "owner" };

  // 3. Judge — only for genuinely new user messages.
  if (deps.prompt !== undefined) {
    const answer = await consultJudge(deps, deps.prompt);
    if (answer) {
      if (answer.confidence >= deps.settings.judge.threshold) {
        return { mode: answer.mode, source: "judge", confidence: answer.confidence };
      }
      return {
        mode: deps.settings.defaultMode,
        source: "judge_abstained_low_confidence",
        confidence: answer.confidence,
      };
    }
  }

  // 4. Default (judge off, unconfigured, failed, or continuation turn).
  return { mode: deps.settings.defaultMode, source: "default" };
}
