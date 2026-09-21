/**
 * TypeSafe System One judge client — decides which mode a user prompt needs.
 *
 * API: POST {baseUrl}/v1/systemone {state, model, questions} → answers with
 * {choice, confidence, probabilities}. Choice + Noul ride one call (docs:
 * adding questions barely changes response time).
 *
 * Provider "openrouter" serves jev as a chat model: a constrained JSON chat
 * completion normalized to the same decision shape. Both transports are
 * injectable and fail-open (null) on any error, timeout, or invalid shape —
 * the judge never blocks a turn.
 *
 * Design: docs/long-horizon-design.md §2.
 */

import type { LhMode } from "../modes.js";
import { isLhMode } from "../modes.js";
import type { JudgeSettings } from "../settings.js";

export interface JudgeAnswer {
  readonly mode: LhMode;
  readonly confidence: number;
}

export type JudgeResult = JudgeAnswer | null;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JudgeTransport {
  readonly provider: "typesafe" | "openrouter";
  ask(state: string, signal: AbortSignal): Promise<JudgeResult>;
}

export interface JudgeDeps {
  readonly settings: JudgeSettings;
  readonly fetchImpl?: FetchLike;
  readonly env?: Record<string, string | undefined>;
}

const DEFAULT_TYPESAFE_BASE = "https://api.typesafe.ai";
const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai";
export const JUDGE_TIMEOUT_MS = 1_000;

function apiKey(settings: JudgeSettings, env: Record<string, string | undefined>): string | undefined {
  return settings.provider === "typesafe" ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY;
}

function baseUrl(settings: JudgeSettings): string {
  const configured = settings.baseUrl.trim();
  if (configured) return configured.replace(/\/$/, "");
  return settings.provider === "typesafe" ? DEFAULT_TYPESAFE_BASE : DEFAULT_OPENROUTER_BASE;
}

/** The one judge question set: the mode choice plus a decomposable side-signal. */
export function buildQuestions(): Record<string, unknown> {
  return {
    mode: {
      type: "choice",
      instructions: "Which execution mode fits this request? Route by task shape and complexity.",
      criteria: {
        goal: "One objective pursued across many turns until verifiably true",
        ralph: "Work through a task file or checklist over many iterations",
        swarm: "Several independent items parallel workers can settle, then synthesize",
        graph: "Multi-step work where later steps depend on earlier results",
        none: "Straight-to-the-point request — a rename, small edit, quick question",
      },
    },
    decomposable: {
      type: "noul",
      instructions: "Can this be split into independent parallel items?",
    },
  };
}

function normalizeConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0;
}

function parseAnswer(raw: unknown): JudgeResult {
  if (typeof raw !== "object" || raw === null) return null;
  const answers = (raw as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return null;
  const mode = (answers as Record<string, unknown>).mode;
  if (typeof mode !== "object" || mode === null) return null;
  const choice = (mode as Record<string, unknown>).choice;
  if (typeof choice !== "string" || !isLhMode(choice)) return null;
  return { mode: choice, confidence: normalizeConfidence((mode as Record<string, unknown>).confidence) };
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) return null;
  return (await response.json()) as unknown;
}

/** Native System One transport (provider: typesafe). */
export function createTypesafeTransport(deps: JudgeDeps): JudgeTransport {
  const { settings } = deps;
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;
  return {
    provider: "typesafe",
    async ask(state, signal) {
      const key = apiKey(settings, env);
      if (!key) return null;
      try {
        const raw = await postJson(
          fetchImpl,
          `${baseUrl(settings)}/v1/systemone`,
          { authorization: `Bearer ${key}` },
          { state, model: settings.model, questions: buildQuestions() },
          signal,
        );
        return parseAnswer(raw);
      } catch {
        return null;
      }
    },
  };
}

/**
 * OpenRouter transport: jev served as a chat model. Same decision shape via a
 * JSON-constrained completion; the prompt mirrors the System One question.
 */
export function createOpenRouterTransport(deps: JudgeDeps): JudgeTransport {
  const { settings } = deps;
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;
  const instruction =
    "You are a mode router. Given a user request, answer which execution mode fits. " +
    'Respond ONLY with JSON: {"mode":"goal|ralph|swarm|graph|none","confidence":0..1}. ' +
    "goal = one objective pursued until verifiably true; ralph = work through a task file " +
    "over iterations; swarm = independent parallel items then synthesize; graph = later steps " +
    "depend on earlier results; none = straight-to-the-point small request. Be conservative.";
  return {
    provider: "openrouter",
    async ask(state, signal) {
      const key = apiKey(settings, env);
      if (!key) return null;
      try {
        const raw = await postJson(
          fetchImpl,
          `${baseUrl(settings)}/api/v1/chat/completions`,
          { authorization: `Bearer ${key}`, "x-title": "unipi-long-horizon" },
          {
            model: settings.model,
            messages: [
              { role: "system", content: instruction },
              { role: "user", content: state },
            ],
            response_format: { type: "json_object" },
            max_tokens: 60,
          },
          signal,
        );
        const content = (raw as { choices?: Array<{ message?: { content?: unknown } }> })
          ?.choices?.[0]?.message?.content;
        if (typeof content !== "string") return null;
        const match = content.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]) as { mode?: unknown; confidence?: unknown };
        if (typeof parsed.mode !== "string" || !isLhMode(parsed.mode)) return null;
        return { mode: parsed.mode, confidence: normalizeConfidence(parsed.confidence) };
      } catch {
        return null;
      }
    },
  };
}

export function createJudgeTransport(deps: JudgeDeps): JudgeTransport {
  return deps.settings.provider === "openrouter"
    ? createOpenRouterTransport(deps)
    : createTypesafeTransport(deps);
}

/**
 * Ask with a hard timeout. Timeout or transport failure → null (fail-open);
 * callers fall back to owner mode or the configured default. The ask is raced
 * against the timeout so even a signal-ignoring transport cannot hang the gate.
 */
export async function askJudge(
  transport: JudgeTransport,
  state: string,
  timeoutMs: number = JUDGE_TIMEOUT_MS,
): Promise<JudgeResult> {
  const controller = new AbortController();
  const timedOut = Symbol("judge_timeout");
  const timer = setTimeout(() => controller.abort(new Error("judge timeout")), timeoutMs);
  const timeout = new Promise<typeof timedOut>((resolve) =>
    setTimeout(() => resolve(timedOut), timeoutMs).unref?.(),
  );
  try {
    const result = await Promise.race([transport.ask(state, controller.signal), timeout]);
    return result === timedOut ? null : result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
