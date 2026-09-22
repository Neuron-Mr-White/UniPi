/**
 * Fallback API key for the openrouter-style judge transport.
 *
 * Most unipi users route models through omniroute (an OpenAI-compatible proxy
 * at router.oino.dev) rather than setting OPENROUTER_API_KEY. So when the judge
 * uses the openrouter provider and no OPENROUTER_API_KEY is present, fall back
 * to the omniroute bridge key so "turn the judge on" works out of the box.
 *
 * Read once and cached; never throws.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: string | null | undefined;

export function omnirouteApiKey(): string | null {
  if (cached !== undefined) return cached;
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "omniroute-bridge", "config.json"), "utf8"),
    ) as { apiKey?: unknown; enabled?: unknown };
    cached = cfg.enabled !== false && typeof cfg.apiKey === "string" && cfg.apiKey ? cfg.apiKey : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Return an env view for the judge transport, injecting OPENROUTER_API_KEY from
 * the omniroute bridge when the provider is openrouter AND the call targets the
 * omniroute/oino proxy (baseUrl contains "oino"), and no explicit key is set.
 * The fallback must NOT fire for real openrouter.ai calls (baseUrl empty or
 * pointing elsewhere) — the oino key would 401 there and fail open silently.
 */
export function judgeEnv(
  provider: "typesafe" | "openrouter",
  base: Record<string, string | undefined> = process.env,
  baseUrl = "",
  settingsApiKey = "",
): Record<string, string | undefined> {
  if (provider !== "openrouter") return base;
  // Precedence: settings file (works env-free) > environment > oino bridge.
  if (settingsApiKey) return { ...base, OPENROUTER_API_KEY: settingsApiKey };
  if (base.OPENROUTER_API_KEY) return base;
  if (!baseUrl.includes("oino")) return base; // only the omniroute proxy accepts this key
  const key = omnirouteApiKey();
  return key ? { ...base, OPENROUTER_API_KEY: key } : base;
}

/** Test hook. */
export function resetOmnirouteKeyCache(): void {
  cached = undefined;
}
