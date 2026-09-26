/**
 * Persist pi's startup model into its global settings file
 * ($PI_CODING_AGENT_DIR/settings.json, default ~/.pi/agent/settings.json) —
 * the same keys pi's own `/model` ctrl+s writes
 * (settings-manager.d.ts setDefaultModelAndProvider/setDefaultThinkingLevel).
 * Atomic: write temp file + rename. Preserves every other key.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function piSettingsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const envDir = env.PI_CODING_AGENT_DIR?.trim();
  return join(envDir !== undefined && envDir.length > 0 ? envDir : join(home, ".pi", "agent"), "settings.json");
}

export function mergeDefaultModel(
  raw: unknown,
  patch: { provider: string; model: string; thinkingLevel?: string },
): Record<string, unknown> {
  const settings = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  settings.defaultProvider = patch.provider;
  settings.defaultModel = patch.model;
  if (patch.thinkingLevel !== undefined) settings.defaultThinkingLevel = patch.thinkingLevel;
  return settings;
}

export function persistDefaultModel(
  patch: { provider: string; model: string; thinkingLevel?: string },
  deps: { readFile?: (p: string) => string; env?: NodeJS.ProcessEnv } = {},
): string {
  const path = piSettingsPath(deps.env);
  let current: unknown = {};
  try {
    current = JSON.parse(deps.readFile !== undefined ? deps.readFile(path) : readFileSync(path, "utf8")) as unknown;
  } catch {
    current = {};
  }
  const next = mergeDefaultModel(current, patch);
  const tmp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return path;
}
