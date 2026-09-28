/**
 * @pi-unipi/utility — Automatic session naming
 *
 * After every confirmed round (agent_end without error/abort) whose prompt the
 * user typed: gate (prefilter + jev) → isolated one-tool rename session →
 * pi.setSessionName. Names the user sets (pi's /name) are respected: once the
 * current name differs from the last auto name, auto-rename stops for that
 * session. "Rename now" in /unipi:settings bypasses the gate.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev, registerCommandRunner, resolveDecisionModel } from "@pi-unipi/core";
import { readRenameSettings } from "../settings.js";
import { detectHerdr, syncPaneTitle, type HerdrEnv } from "../herdr-sync.js";
import { decide, gateRequest, isChatter } from "./gate.js";
import { runRenameSession } from "./session.js";

/** Custom entry recording names auto-rename set (so resume can tell them from /name). */
export const AUTO_NAME_ENTRY = "unipi:auto-name";
/** Rounds that must pass between two automatic renames (never twice in one round). */
const MIN_ROUNDS_BETWEEN = 1;
const HERDR_POLL_MS = 3000;

/** Debug trail, gated by UNIPI_DEBUG_RENAME=1 → ~/.unipi/logs/rename.log. */
function debugLog(line: string): void {
  if (process.env.UNIPI_DEBUG_RENAME !== "1") return;
  try {
    const dir = join(homedir(), ".unipi", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "rename.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best effort
  }
}

export function registerAutoRename(pi: ExtensionAPI): void {
  let requests: string[] = [];
  let pending: string | null = null;
  let lastAutoName: string | null = null;
  let roundsSinceRename = Number.POSITIVE_INFINITY;
  let inFlight = false;
  let herdr: HerdrEnv = { enabled: false };
  let herdrShown: string | null = null;
  let herdrTimer: ReturnType<typeof setInterval> | null = null;

  const currentName = (): string | null => {
    try {
      return pi.getSessionName() ?? null;
    } catch {
      return null;
    }
  };

  const syncHerdr = (name: string | null): void => {
    if (!herdr.enabled || name === herdrShown || !readRenameSettings().herdrSync) return;
    herdrShown = name;
    void syncPaneTitle(herdr, name);
  };

  const apply = (name: string): void => {
    if (name === currentName()) return;
    pi.setSessionName(name);
    lastAutoName = name;
    roundsSinceRename = 0;
    pi.appendEntry(AUTO_NAME_ENTRY, { name });
    syncHerdr(name);
  };

  const rename = async (ctx: ExtensionContext, force: boolean, topicChanged = false): Promise<string | undefined> => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      const settings = readRenameSettings(ctx.cwd);
      const name = await runRenameSession(ctx, { currentName: currentName(), requests, model: settings.model, topicChanged }, debugLog);
      debugLog(`rename session → ${name === undefined ? "(no name)" : JSON.stringify(name)}`);
      if (name && (force || name !== currentName())) apply(name);
      return name;
    } catch (error) {
      debugLog(`rename session failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      inFlight = false;
    }
  };

  registerCommandRunner("unipi:rename-now", async (raw: unknown) => {
    const ctx = raw as ExtensionContext;
    if (requests.length === 0) {
      ctx.ui?.notify?.("Nothing to name yet — send a request first.", "info");
      return;
    }
    const name = await rename(ctx, true);
    ctx.ui?.notify?.(name ? `Session named "${name}"` : "Could not generate a name.", name ? "info" : "warning");
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      requests = [];
      pending = null;
      roundsSinceRename = Number.POSITIVE_INFINITY;
      const entries = (ctx.sessionManager?.getEntries?.() ?? []) as Array<{ type?: string; customType?: string; data?: { name?: unknown } }>;
      const last = entries.findLast((e) => e.type === "custom" && e.customType === AUTO_NAME_ENTRY);
      lastAutoName = typeof last?.data?.name === "string" ? last.data.name : null;
      herdr = detectHerdr();
      herdrShown = null;
      syncHerdr(currentName());
      if (herdrTimer) clearInterval(herdrTimer);
      herdrTimer = herdr.enabled ? setInterval(() => syncHerdr(currentName()), HERDR_POLL_MS) : null;
      herdrTimer?.unref?.();
    } catch {
      // Naming is best-effort — never block session start.
    }
  });

  pi.on("input", (event) => {
    try {
      if (event.source === "extension") return;
      const text = (event.text ?? "").trim();
      if (!text || text.startsWith("/")) return;
      requests = [...requests, text].slice(-6);
      pending = text;
    } catch {
      // ignore
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const prompt = pending;
    pending = null;
    roundsSinceRename++;
    try {
      if (!prompt || inFlight) return;
      const skip = (why: string) => debugLog(`skip ${JSON.stringify(prompt.slice(0, 60))}: ${why}`);
      if (!readRenameSettings(ctx.cwd).auto) return skip("auto-rename off");
      const lastAssistant = [...(event.messages ?? [])].reverse().find((m) => (m as { role?: string }).role === "assistant") as { stopReason?: string } | undefined;
      if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") return skip(`round ${lastAssistant.stopReason}`);
      const name = currentName();
      if (name && name !== lastAutoName) return skip("user-set name"); // user-set name wins
      if (name && roundsSinceRename < MIN_ROUNDS_BETWEEN) return skip("renamed recently");
      if (isChatter(prompt)) return skip("chatter");
      const input = { prompt, currentName: name, earlier: requests };
      // Detached: the next prompt never waits on naming.
      void (async () => {
        try {
          const answers = await askJev({ ...gateRequest(input), settings: resolveDecisionModel(ctx.cwd ?? process.cwd(), "utility"), env: process.env });
          const decision = decide(input, answers);
          debugLog(`gate ${JSON.stringify(prompt.slice(0, 60))} name=${JSON.stringify(name)} → ${decision.rename ? "rename" : "skip"} (${decision.reason})`);
          if (decision.rename) await rename(ctx, false, Boolean(name));
        } catch {
          // Naming must never disturb the main session.
        }
      })();
    } catch {
      // ignore
    }
  });

  pi.on("session_shutdown", () => {
    if (herdrTimer) clearInterval(herdrTimer);
    herdrTimer = null;
  });
}
