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

import { askJev, isJevDecisionsModel, type JevAnswer } from "@pi-unipi/core";
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
/** Chat-model judges (openrouter/OpenAI-compat proxies) are slower than jev. */
export const JUDGE_TIMEOUT_OPENROUTER_MS = 6_000;

/** Resolve the judge abort budget: explicit override, else provider default. */
export function judgeTimeoutMs(settings: JudgeSettings): number {
  if (settings.timeoutMs && settings.timeoutMs > 0) return settings.timeoutMs;
  return effectiveProvider(settings) === "openrouter" ? JUDGE_TIMEOUT_OPENROUTER_MS : JUDGE_TIMEOUT_MS;
}

/**
 * "custom" rides the openrouter-shape transport too (it self-detects jev),
 * but is unconfigured until a baseUrl is set — the transport then fails open.
 */
export function effectiveProvider(settings: JudgeSettings): "typesafe" | "openrouter" {
  return settings.provider === "typesafe" ? "typesafe" : "openrouter";
}

function apiKey(settings: JudgeSettings, env: Record<string, string | undefined>): string | undefined {
  return effectiveProvider(settings) === "typesafe" ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY;
}

function baseUrl(settings: JudgeSettings): string {
  const configured = settings.baseUrl.trim();
  if (configured) return configured.replace(/\/$/, "");
  return settings.provider === "typesafe" ? DEFAULT_TYPESAFE_BASE : DEFAULT_OPENROUTER_BASE;
}

/**
 * Chat-completions URL for the openrouter-style transport.
 *
 * OpenRouter's canonical path is `/api/v1/chat/completions`. OpenAI-compatible
 * proxies (omniroute/oino, LiteLLM, vLLM, …) instead expose `/v1/chat/completions`.
 * A configured baseUrl that already ends in a version segment (`/v1`, `/api/v1`)
 * is treated as the API root and only gets `/chat/completions` appended, so any
 * OpenAI-compat gateway works by pointing baseUrl at it (e.g.
 * `https://router.oino.dev/v1`). Bare hosts fall back to OpenRouter's prefix.
 */
function chatCompletionsUrl(settings: JudgeSettings): string {
  const base = baseUrl(settings);
  if (/\/(?:api\/)?v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/api/v1/chat/completions`;
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

function normalizeConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0;
}

function parseAnswer(answers: Record<string, JevAnswer>): JudgeResult {
  const mode = (answers as Record<string, unknown>).mode;
  if (typeof mode !== "object" || mode === null) return null;
  const choice = (mode as Record<string, unknown>).choice;
  if (typeof choice !== "string" || !isLhMode(choice)) return null;
  return { mode: choice, confidence: normalizeConfidence((mode as Record<string, unknown>).confidence) };
}

/** Native System One transport (provider: typesafe) — core jev client. */
export function createTypesafeTransport(deps: JudgeDeps): JudgeTransport {
  const { settings } = deps;
  return {
    provider: "typesafe",
    async ask(state, signal) {
      const raw = await askJev({
        state,
        questions: buildQuestions(),
        settings: { ...settings, timeoutMs: settings.timeoutMs },
        signal,
        fetchImpl: deps.fetchImpl,
        env: deps.env ?? process.env,
      });
      return raw ? parseAnswer(raw) : null;
    },
  };
}

/**
 * OpenRouter transport. Two shapes, auto-detected by model id:
 *
 *   - DECISIONS models (typesafe/jev-*): served via /api/alpha/decisions —
 *     OpenRouter's hosting of TypeSafe's System One protocol. Same payload
 *     and response shape as the native /v1/systemone call (choice +
 *     probabilities + calibrated confidence), ~0.5s, ~$0.00002/call.
 *   - Chat models (anything else): JSON-constrained chat completion; the
 *     prompt mirrors the System One question.
 */
export function createOpenRouterTransport(deps: JudgeDeps): JudgeTransport {
  const { settings } = deps;
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;
  // provider=custom without a baseUrl has nowhere to send the call — the
  // judge is unconfigured and fails open (null) without any network I/O.
  const unconfigured = settings.provider === "custom" && !settings.baseUrl.trim();
  const instruction =
    "You are a mode router. Given a user request, answer which execution mode fits. " +
    'Respond ONLY with JSON: {"mode":"goal|ralph|swarm|graph|none","confidence":0..1}. ' +
    "goal = one objective pursued until verifiably true; ralph = work through a task file " +
    "over iterations; swarm = independent parallel items then synthesize; graph = later steps " +
    "depend on earlier results; none = straight-to-the-point small request. Be conservative.";
  const useDecisions = isJevDecisionsModel(settings.model);
  return {
    provider: "openrouter",
    async ask(state, signal) {
      if (unconfigured) return null;
      const key = apiKey(settings, env);
      if (!key) return null;
      try {
        if (useDecisions) {
          // System One shape — parseAnswer reads answers.<q>.choice/confidence,
          // which OpenRouter's decisions endpoint returns verbatim (core client).
          const raw = await askJev({
            state,
            questions: buildQuestions(),
            settings: { ...settings, timeoutMs: settings.timeoutMs },
            signal,
            fetchImpl: deps.fetchImpl,
            env,
          });
          return raw ? parseAnswer(raw) : null;
        }
        const raw = await postJson(
          fetchImpl,
          chatCompletionsUrl(settings),
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
  return effectiveProvider(deps.settings) === "openrouter"
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
