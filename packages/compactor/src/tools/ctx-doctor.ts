/**
 * Compactor diagnostics — settings, Pi's compaction switch, leftovers.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompactorConfig } from "../types.js";

export interface DoctorResult {
  healthy: boolean;
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "warn";
    message: string;
  }>;
}

export const LEGACY_DB_DIR = join(homedir(), ".unipi", "db", "compactor");

function piCompactionEnabled(): boolean | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8"));
    const enabled = raw?.compaction?.enabled;
    return typeof enabled === "boolean" ? enabled : true;
  } catch {
    return null;
  }
}

function dirSizeMb(dir: string): number {
  try {
    return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0) / (1024 * 1024);
  } catch {
    return 0;
  }
}

export function ctxDoctor(config: CompactorConfig, opts: { hasModel: boolean }): DoctorResult {
  const checks: DoctorResult["checks"] = [];
  const method = config.method === "vcc" ? "lossless" : "model summary";
  const when = config.trigger === "pi" ? "Pi's context limit" : `${config.thresholdPercent}% of context`;
  checks.push({ name: "Settings", status: "pass", message: `method: ${method} · when: ${when} · Pi's /compact: ${config.piCompact}` });

  const piAuto = piCompactionEnabled();
  if (config.trigger === "pi" && piAuto === false) {
    checks.push({
      name: "Pi auto-compaction",
      status: "fail",
      message: "compaction.enabled is false in ~/.pi/agent/settings.json, so nothing compacts automatically. Enable it or set When = at a percentage.",
    });
  } else {
    checks.push({ name: "Pi auto-compaction", status: "pass", message: piAuto === null ? "Pi settings unreadable (defaults apply)" : "enabled" });
  }

  if (config.method === "llm" && !opts.hasModel) {
    checks.push({ name: "Model", status: "warn", message: "model summaries need a selected model" });
  }

  if (existsSync(LEGACY_DB_DIR)) {
    checks.push({
      name: "Old continuity database",
      status: "warn",
      message: `${LEGACY_DB_DIR} (${dirSizeMb(LEGACY_DB_DIR).toFixed(1)} MB) is no longer used and can be deleted.`,
    });
  }

  return { healthy: checks.every((c) => c.status !== "fail"), checks };
}
