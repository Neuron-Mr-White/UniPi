/**
 * Jev settings source — reads the long-horizon Decision-model settings from
 * the engine so every jev consumer (mode router, skill exposure, watchdog)
 * shares one provider/model/key/baseUrl configuration.
 */

import { getSettings } from "../settings/engine.js";
import type { JevSettings } from "./client.js";

/** Read the Decision-model settings (long-horizon judge) as JevSettings. */
export function readJudgeJevSettings(cwd: string): JevSettings {
  const raw = getSettings("long-horizon", cwd) as {
    judge?: Record<string, unknown>;
  };
  const j = raw?.judge ?? {};
  return {
    provider: j.provider === "typesafe" ? "typesafe" : "openrouter",
    model: typeof j.model === "string" ? j.model : "",
    baseUrl: typeof j.baseUrl === "string" ? j.baseUrl : "",
    apiKey: typeof j.apiKey === "string" ? j.apiKey : "",
    timeoutMs: typeof j.timeoutMs === "number" ? j.timeoutMs : 0,
  };
}
