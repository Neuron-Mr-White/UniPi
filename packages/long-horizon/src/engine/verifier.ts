/**
 * Goal verifier — the independent judge for completion claims.
 *
 * Propose + verify: the worker's summary is untrusted input; the verifier
 * sees a bounded evidence brief (objective + claim + changed files/commands
 * + recent transcript tail) and returns a strict verdict:
 *
 *   met          clear, concrete evidence the full objective is satisfied
 *   not_met      evidence gaps, with `missing[]` naming them
 *   impossible   the objective violates constraints/physics (not merely hard)
 *   inconclusive evidence too weak either way (also the fail-open shape)
 *
 * Failure semantics (Maka): timeout/error/unparseable → inconclusive with
 * evaluatorFailed=true — continuation stays open and the turn counts as
 * NEITHER progress nor stall.
 *
 * Design: docs/long-horizon-design.md §4, study §2/§5.
 */

import { createHash } from "node:crypto";

export const MAX_CHANGE_CHARS = 4_000;
export const MAX_CHANGE_ITEMS = 100;
export const MAX_RECENT_TAIL_MESSAGES = 5;
export const MAX_RECENT_MESSAGE_CHARS = 800;
export const DEFAULT_VERIFIER_TIMEOUT_MS = 30_000;

export interface EvidenceBriefInput {
  readonly objective: string;
  readonly objectiveDigest: string;
  readonly claim?: string;
  readonly changedFiles: readonly string[];
  readonly commands: readonly string[];
  readonly recentTail: readonly { readonly role: string; readonly text: string }[];
}

export interface VerificationVerdict {
  readonly verdict: "met" | "not_met" | "impossible" | "inconclusive";
  readonly reason: string;
  readonly missing: readonly string[];
  /** True when the evaluator produced no real judgment (timeout/error/parse). */
  readonly evaluatorFailed: boolean;
}

export type VerifierEvaluate = (prompt: string, signal: AbortSignal) => Promise<string>;

export interface VerifierDeps {
  readonly evaluate: VerifierEvaluate;
  readonly timeoutMs?: number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

const VERIFIER_SYSTEM = `You are the completion verifier for an autonomous coding agent. Given an OBJECTIVE and an EVIDENCE BRIEF, judge whether the objective is fully satisfied.

Respond ONLY with valid JSON in this exact shape:
{"verdict": "met" | "not_met" | "impossible" | "inconclusive", "reason": "one sentence", "missing": ["short evidence gap", ...]}

Field rules:
- met: ONLY with clear, concrete evidence the full objective is satisfied. Match verification scope to requirement scope; never accept a narrower substitute.
- not_met: evidence is incomplete or contradicts completion. List every unmet requirement in missing[] (short strings, actionable).
- impossible: ONLY if the objective violates constraints or physics — not merely hard.
- inconclusive: evidence is too weak or indirect to judge either way.
- reason: concise (under 160 chars), specific.

Be conservative. Uncertain evidence is not met; treat tests, green checks, and search results as evidence only after confirming they cover the requirement.`;

/** Assemble the bounded evidence brief (deterministic, truncation-limited). */
export function assembleEvidenceBrief(input: EvidenceBriefInput): string {
  const boundedList = (items: readonly string[], cap: number): string[] => {
    const limited = items.slice(0, MAX_CHANGE_ITEMS);
    let total = 0;
    const out: string[] = [];
    for (const item of limited) {
      const slice = item.slice(0, Math.max(0, cap - total));
      if (slice.length === 0) break;
      out.push(slice);
      total += slice.length;
    }
    return out;
  };

  const fileBudget = Math.floor(MAX_CHANGE_CHARS / 2);
  const files = boundedList(input.changedFiles, fileBudget);
  const commands = boundedList(input.commands, fileBudget);
  const tail = input.recentTail.slice(-MAX_RECENT_TAIL_MESSAGES).map((message) => ({
    role: message.role,
    text: message.text.slice(0, MAX_RECENT_MESSAGE_CHARS),
  }));

  return [
    "--- OBJECTIVE ---",
    input.objective,
    `--- OBJECTIVE DIGEST ---`,
    input.objectiveDigest,
    input.claim !== undefined ? "--- WORKER CLAIM (untrusted) ---" : undefined,
    input.claim !== undefined ? input.claim.slice(0, MAX_RECENT_MESSAGE_CHARS) : undefined,
    "--- CHANGED FILES ---",
    files.length > 0 ? files.join("\n") : "(none reported)",
    "--- COMMANDS RUN ---",
    commands.length > 0 ? commands.join("\n") : "(none reported)",
    "--- RECENT CONVERSATION TAIL ---",
    tail.length > 0
      ? tail.map((message) => `${message.role}: ${message.text}`).join("\n")
      : "(empty)",
    "--- YOUR VERDICT (JSON only) ---",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function buildVerificationPrompt(objective: string, brief: string): string {
  return [VERIFIER_SYSTEM, "", brief, ""].join("\n");
}

/** Parse with the same tolerance Maka uses: prefer the JSON mentioning verdict. */
export function parseVerification(raw: string): VerificationVerdict {
  const fallback: VerificationVerdict = {
    verdict: "inconclusive",
    reason: "Evaluator produced unparseable output",
    missing: [],
    evaluatorFailed: true,
  };
  const match = raw.match(/\{[^{}]*"verdict"[^{}]*\}/s) ?? raw.match(/\{[\s\S]*?\}/);
  if (!match) return fallback;
  try {
    const parsed = JSON.parse(match[0]) as {
      verdict?: unknown;
      reason?: unknown;
      missing?: unknown;
    };
    if (
      parsed.verdict !== "met" &&
      parsed.verdict !== "not_met" &&
      parsed.verdict !== "impossible" &&
      parsed.verdict !== "inconclusive"
    ) {
      return fallback;
    }
    const missing = Array.isArray(parsed.missing)
      ? parsed.missing.filter((m): m is string => typeof m === "string").slice(0, 10).map((m) => m.slice(0, 200))
      : [];
    return {
      verdict: parsed.verdict,
      reason:
        typeof parsed.reason === "string" && parsed.reason.trim()
          ? parsed.reason.slice(0, 200)
          : "No reason provided",
      missing,
      evaluatorFailed: false,
    };
  } catch {
    return { ...fallback, reason: "Evaluator JSON parse failed" };
  }
}

/** Race the evaluator against a hard timeout; every failure is inconclusive. */
export async function verifyCompletion(
  deps: VerifierDeps,
  objective: string,
  brief: string,
  abortSignal?: AbortSignal,
): Promise<VerificationVerdict> {
  const prompt = buildVerificationPrompt(objective, brief);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const controller = new AbortController();
  const timedOut = Symbol("verifier_timeout");
  let timer: unknown;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timer = setT(() => resolve(timedOut), timeoutMs);
  });
  const cancel = () => controller.abort(abortSignal?.reason);
  if (abortSignal?.aborted) cancel();
  else abortSignal?.addEventListener("abort", cancel, { once: true });

  try {
    const result = await Promise.race([deps.evaluate(prompt, controller.signal), timeout]);
    if (result === timedOut) {
      return {
        verdict: "inconclusive",
        reason: "Evaluator timed out (continuing)",
        missing: [],
        evaluatorFailed: true,
      };
    }
    return parseVerification(result);
  } catch {
    return {
      verdict: "inconclusive",
      reason: "Evaluator call failed (continuing)",
      missing: [],
      evaluatorFailed: true,
    };
  } finally {
    abortSignal?.removeEventListener("abort", cancel);
    if (timer !== undefined) clearT(timer);
  }
}

/** Fingerprint a brief for cache/dedup diagnostics. */
export function fingerprintBrief(brief: string): string {
  return createHash("sha256").update(brief).digest("hex").slice(0, 16);
}
