/**
 * Jev client — TypeSafe System One decisions via the same transports the
 * long-horizon judge uses (native typesafe /v1/systemone, OpenRouter
 * /api/alpha/decisions for typesafe/jev-* models).
 *
 * Deliberately transport-only: callers own the questions, answer parsing and
 * the chat-model fallback (long-horizon keeps its own). Fail-open: any error,
 * missing key, timeout or unparseable answer resolves to null.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The slice of long-horizon's judge settings the client needs. */
export interface JevSettings {
  /** typesafe = native systemone; openrouter/custom = decisions endpoint. */
  provider: "typesafe" | "openrouter" | "custom";
  model: string;
  baseUrl: string;
  /** Stored key — wins over the environment (judge precedence). */
  apiKey: string;
  /** Explicit abort budget; 0 = provider default (1s native / 6s decisions). */
  timeoutMs?: number;
}

/** One answered question: choice+confidence (choice) or noul (0–1). */
export interface JevAnswer {
  choice?: string;
  confidence?: number;
  noul?: number;
  [key: string]: unknown;
}

export interface JevAskParams {
  state: string;
  questions: Record<string, unknown>;
  settings: JevSettings;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TYPESAFE_BASE = "https://api.typesafe.ai";
const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai";
export const JEV_TIMEOUT_NATIVE_MS = 1_000;
/** Decisions-model calls are slower than native jev but still sub-second-ish. */
export const JEV_TIMEOUT_DECISIONS_MS = 6_000;

/** Decision-capable models on the openrouter-shape transports. */
export function isJevDecisionsModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.startsWith("typesafe/") || m.includes("jev");
}

/** Effective transport: only typesafe is native; openrouter/custom share it. */
export function jevEffectiveProvider(settings: JevSettings): "typesafe" | "openrouter" {
  return settings.provider === "typesafe" ? "typesafe" : "openrouter";
}

/** Explicit override, else provider default (same rule as the judge). */
export function jevTimeoutMs(settings: JevSettings): number {
  if (settings.timeoutMs && settings.timeoutMs > 0) return settings.timeoutMs;
  return jevEffectiveProvider(settings) === "openrouter" ? JEV_TIMEOUT_DECISIONS_MS : JEV_TIMEOUT_NATIVE_MS;
}

/** Stored key wins over the environment (judge precedence). */
export function jevApiKey(settings: JevSettings, env: Record<string, string | undefined>): string | undefined {
  const stored = settings.apiKey.trim();
  if (stored) return stored;
  return jevEffectiveProvider(settings) === "typesafe" ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY;
}

function jevBaseUrl(settings: JevSettings): string {
  const configured = settings.baseUrl.trim();
  if (configured) return configured.replace(/\/$/, "");
  return settings.provider === "typesafe" ? DEFAULT_TYPESAFE_BASE : DEFAULT_OPENROUTER_BASE;
}

/** Native System One endpoint. */
export function jevSystemoneUrl(settings: JevSettings): string {
  return `${jevBaseUrl(settings)}/v1/systemone`;
}

/**
 * OpenRouter alpha decisions endpoint. A configured base already ending in a
 * version segment (/api/alpha, /v1, /api/v1) is treated as the API root.
 */
export function jevDecisionsUrl(settings: JevSettings): string {
  const base = jevBaseUrl(settings);
  if (/\/(?:api\/alpha|api\/)?v\d+$/.test(base)) return `${base}/decisions`;
  return `${base}/api/alpha/decisions`;
}

/**
 * Ask jev one System One call and return the raw answers object
 * (answers.<questionId> → {choice?, confidence?, noul?}). Null = fail-open.
 */
export async function askJev(params: JevAskParams): Promise<Record<string, JevAnswer> | null> {
  const { settings } = params;
  const env = params.env ?? process.env;
  const provider = jevEffectiveProvider(settings);

  // provider=custom without a baseUrl has nowhere to send the call.
  if (settings.provider === "custom" && !settings.baseUrl.trim()) return null;

  const url = provider === "typesafe" || isJevDecisionsModel(settings.model)
    ? provider === "typesafe"
      ? jevSystemoneUrl(settings)
      : jevDecisionsUrl(settings)
    : null; // non-jev models on the decisions endpoint are unsupported here
  if (!url) return null;

  const key = jevApiKey(settings, env);
  if (!key) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("jev timeout")), jevTimeoutMs(settings));
  const onAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onAbort);

  const fetchImpl: FetchLike = params.fetchImpl ?? ((u, init) => fetch(u, init));
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(provider === "openrouter" ? { "x-title": "unipi-jev" } : {}),
      },
      body: JSON.stringify({ state: params.state, model: settings.model, questions: params.questions }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { answers?: unknown };
    const answers = parsed?.answers;
    if (typeof answers !== "object" || answers === null) return null;
    return answers as Record<string, JevAnswer>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", onAbort);
  }
}
