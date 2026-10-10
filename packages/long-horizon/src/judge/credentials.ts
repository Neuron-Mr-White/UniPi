/**
 * Judge credentials — provider-neutral key resolution.
 *
 * Precedence (first hit wins):
 *   1. the stored judge key (settings: Decision Model → API key)
 *   2. the environment (TYPESAFE_API_KEY for typesafe, OPENROUTER_API_KEY otherwise)
 *   3. pi's own model registry / auth storage:
 *        - a pi model whose baseUrl matches the judge baseUrl → that model's
 *          request auth (any provider an extension registered, e.g. a gateway)
 *        - else the pi provider named like the judge provider
 *          (`openrouter`, `typesafe`) → its stored key
 *
 * UniPi knows no third-party provider: whatever registers models/keys with pi
 * (auth.json, models.json, `pi.registerProvider`) is picked up through the
 * registry. Never throws; a miss leaves the env untouched (judge fails open).
 */

export type JudgeProvider = "typesafe" | "openrouter" | "custom";

/** The slice of pi's ModelRegistry the judge needs (ctx.modelRegistry). */
export interface JudgeKeyRegistry {
  getAll?(): ReadonlyArray<{ provider: string; id: string; baseUrl?: string }>;
  getApiKeyAndHeaders?(model: never): Promise<{ ok: boolean; apiKey?: string }>;
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export interface JudgeKeySettings {
  readonly provider: JudgeProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** Env var the transports read the key from. */
export function judgeKeyVar(provider: JudgeProvider): "TYPESAFE_API_KEY" | "OPENROUTER_API_KEY" {
  return provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
}

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

/** Ask pi's registry for a key matching the judge's endpoint or provider. */
export async function registryKey(
  settings: JudgeKeySettings,
  registry: JudgeKeyRegistry | undefined,
): Promise<string | undefined> {
  if (!registry) return undefined;
  try {
    const base = normalizeUrl(settings.baseUrl);
    if (base && registry.getAll && registry.getApiKeyAndHeaders) {
      const model = registry.getAll().find((m) => m.baseUrl && normalizeUrl(m.baseUrl) === base);
      if (model) {
        const auth = await registry.getApiKeyAndHeaders(model as never);
        if (auth.ok && auth.apiKey) return auth.apiKey;
      }
    }
    // Provider-name lookup only makes sense for the provider's own endpoint.
    if (settings.provider !== "custom" && !base && registry.getApiKeyForProvider) {
      const key = await registry.getApiKeyForProvider(settings.provider);
      if (key) return key;
    }
  } catch {
    // fail open — the judge just stays unconfigured
  }
  return undefined;
}

/** Env view for the judge transport with the resolved key injected. */
export async function judgeEnv(
  settings: JudgeKeySettings,
  base: Record<string, string | undefined> = process.env,
  registry?: JudgeKeyRegistry,
): Promise<Record<string, string | undefined>> {
  const name = judgeKeyVar(settings.provider);
  const stored = settings.apiKey.trim();
  if (stored) return { ...base, [name]: stored };
  if (base[name]) return base;
  const key = await registryKey(settings, registry);
  return key ? { ...base, [name]: key } : base;
}
