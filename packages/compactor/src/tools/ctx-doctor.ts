/**
 * ctx_doctor tool — diagnostics checklist
 */

import { existsSync } from "node:fs";
import { COMPACTOR_CONFIG_PATH } from "../config/manager.js";
import type { SessionDB } from "../session/db.js";
import type { ContentStore } from "../store/index.js";

export interface DoctorResult {
  healthy: boolean;
  checks: Array<{
    name: string;
    status: "pass" | "fail" | "warn";
    message: string;
  }>;
}

export async function ctxDoctor(
  sessionDB: SessionDB,
  contentStore: ContentStore,
): Promise<DoctorResult> {
  const checks: DoctorResult["checks"] = [];

  // Config check
  checks.push({
    name: "Config file",
    status: existsSync(COMPACTOR_CONFIG_PATH) ? "pass" : "warn",
    message: existsSync(COMPACTOR_CONFIG_PATH) ? "Config found" : "Using defaults (no config file)",
  });

  // Session DB check
  try {
    const count = sessionDB.getEventCount("test");
    checks.push({
      name: "Session DB",
      status: "pass",
      message: "SQLite connection OK",
    });
  } catch (err) {
    checks.push({
      name: "Session DB",
      status: "fail",
      message: `Connection failed: ${err}`,
    });
  }

  // Content store check
  try {
    const stats = await contentStore.getStats();
    checks.push({
      name: "Content Store",
      status: "pass",
      message: `FTS5 index: ${stats.sources} sources, ${stats.chunks} chunks`,
    });
  } catch (err) {
    checks.push({
      name: "Content Store",
      status: "fail",
      message: `FTS5 error: ${err}`,
    });
  }

  // Runtime checks
  const runtimes = ["node", "python3", "bash"];
  for (const rt of runtimes) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`command -v ${rt}`, { stdio: "ignore" });
      checks.push({ name: `Runtime: ${rt}`, status: "pass", message: "Available" });
    } catch {
      checks.push({ name: `Runtime: ${rt}`, status: "warn", message: "Not found" });
    }
  }

  const healthy = checks.every((c) => c.status !== "fail");
  return { healthy, checks };
}
