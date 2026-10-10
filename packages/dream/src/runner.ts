/**
 * @pi-unipi/dream — the runner: staging dir + detached dream child.
 *
 * The child is a plain `pi -p` run over a staging directory:
 *   digests/    — produced by src/digest.ts (secret-scrubbed)
 *   proposals/  — where the dream may put skill/check proposals (gated)
 *   DREAM_REPORT.md — the dream's report
 * Memory edits are applied through the memory extension's own tools (loaded
 * via -e) so the MemPalace index stays in sync. Skills and checks only ever
 * land in proposals/ — approval happens from the main session.
 *
 * The child is detached and wrapped in `timeout` (Linux) so it survives this
 * pi process and dies at maxRuntimeMin regardless.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { stateDir } from "@pi-unipi/core";
import { digestSessions, sessionDirFor } from "./digest.ts";
import type { DreamSettings } from "./settings.ts";
import { patchRunMeta, writeRunMeta } from "./runs.ts";

const require_ = createRequire(import.meta.url);

export function craftSkillDir(): string {
  return path.join(path.dirname(require_.resolve("@pi-unipi/dream/package.json")), "skills", "craft-skill");
}

/** Path of the memory package entry (index.ts in the monorepo, main field when published). */
export function resolveMemoryEntry(): string | null {
  try {
    const pkg = require_.resolve("@pi-unipi/memory/package.json");
    const dir = path.dirname(pkg);
    for (const candidate of ["index.ts", "bundled.js", "dist/index.js"]) {
      const p = path.join(dir, candidate);
      if (fs.existsSync(p)) return p;
    }
    const main = JSON.parse(fs.readFileSync(pkg, "utf8")) as { main?: string };
    if (main?.main) return path.join(dir, main.main);
  } catch {
    // not installed alongside — child falls back to direct memory file edits
  }
  return null;
}

export function dreamPrompt(staging: string, memoryRoot: string | null): string {
  return [
    "You are running a DREAM pass: an offline review of past coding-agent sessions. Nobody is watching; work only with files.",
    "",
    "Inputs (read-only):",
    `- ${path.join(staging, "digests", "INDEX.json")} and the per-session files next to it: failed tool calls (call, errorHead = first line(s) of the error, errorTail = end of the error, recovery = the next successful call of the same tool) and user corrections.`,
    "",
    "Goal: make the next session take the shortest path. Find false paths: an error the agent hit, then recovered from with a different call. Group the same false path across sessions.",
    "",
    "For each group, pick the cheapest fix that removes the false path:",
    "- seen in 1 session -> a memory lesson, or nothing if it was a one-off",
    "- seen in 2+ sessions and mechanical (fixed command shape, schema, banned pattern) -> propose an automated check or a one-line lesson keyed by the error text",
    "- seen in 2+ sessions and a multi-step procedure -> propose a skill (write it with the craft-skill skill, loaded for this run)",
    "Also: memory notes that are summaries of past work, duplicates, or contradicted by the digests -> merge, rewrite as a lesson, or delete.",
    "",
    memoryRoot
      ? `Memory: store, update and delete with the memory tools (memory_store / memory_delete) so the search index stays in sync. The memory files live under ${memoryRoot}.`
      : "Memory: edit the memory files directly under the memory directory given in the environment.",
    "",
    "Rules:",
    "- Every lesson and proposal cites at least one session id. No session id, no lesson.",
    "- A lesson is one line: `When <error text or situation>, <shortest path>. [source: <session id>]`",
    "- Never copy a secret, token, or password into any file.",
    `- Write skill and check proposals only under ${path.join(staging, "proposals")}/, never anywhere else. Skills are crafted with the craft-skill skill (scaffold + check scripts).`,
    "",
    `Done when ${path.join(staging, "DREAM_REPORT.md")} exists with three sections: ## Memory edits (applied), ## Proposals (waiting for approval, each with its sources), ## Skipped (groups you judged one-off, with why).`,
  ].join("\n");
}

export interface DreamLaunch {
  staging: string;
  pid: number;
  logFile: string;
  /** Sessions with struggle events that were digested. */
  sessions: number;
  events: number;
}

export interface StartOptions {
  /** Started by hand (`/unipi:dream run`, tray `r`, app "Run now"). */
  manual?: boolean;
  /** Called once when the child exits (only while this pi is still alive). */
  onExit?: (launch: DreamLaunch) => void;
}

/** Build the staging dir (digests + empty proposals + git) and spawn the child. */
export function startDream(cwd: string, cfg: DreamSettings, memoryRoot: string | null, opts: StartOptions = {}): DreamLaunch | null {
  try {
    const root = stateDir("dream", "state", cwd);
    const startedAt = Date.now();
    const staging = path.join(root, `staging-${startedAt}`);
    fs.mkdirSync(path.join(staging, "proposals"), { recursive: true });
    const sessionsDir = sessionDirFor(cwd);
    const digest = digestSessions(sessionsDir, path.join(staging, "digests"));
    const promptFile = path.join(staging, "PROMPT.md");
    fs.writeFileSync(promptFile, dreamPrompt(staging, memoryRoot));
    try {
      spawn("git", ["init", "-q"], { cwd: staging, stdio: "ignore" });
      spawn("git", ["add", "-A"], { cwd: staging, stdio: "ignore" });
      spawn("git", ["-c", "user.email=dream@unipi", "-c", "user.name=dream", "commit", "-qm", "start"], { cwd: staging, stdio: "ignore" });
    } catch {
      // git is a nicety for diffing, not a requirement
    }

    const piBin = process.env.PI_DREAM_BIN ?? "pi";
    const args = [
      "-p",
      "--mode",
      "text",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--skill",
      craftSkillDir(),
      "--session-dir",
      path.join(staging, "sessions"),
      "--thinking",
      cfg.thinking,
    ];
    const memoryEntry = resolveMemoryEntry();
    if (memoryEntry) args.push("-e", memoryEntry);
    if (cfg.model) args.push("--model", cfg.model);
    const prompt = fs.readFileSync(promptFile, "utf8");
    args.push(prompt);

    const logFile = path.join(staging, "trajectory.log");
    const useTimeout = fs.existsSync("/usr/bin/timeout") || fs.existsSync("/bin/timeout");
    const bin = useTimeout ? "timeout" : piBin;
    const binArgs = useTimeout ? [`${cfg.maxRuntimeMin}m`, piBin, ...args] : args;
    const child = spawn(bin, binArgs, {
      cwd: staging,
      detached: true,
      stdio: ["ignore", fs.openSync(logFile, "a"), fs.openSync(logFile, "a")],
      env: { ...process.env, PI_DREAM_STAGING: staging },
    });
    const launch: DreamLaunch = { staging, pid: child.pid ?? -1, logFile, sessions: digest.count, events: digest.events };
    writeRunMeta(staging, { startedAt, pid: launch.pid, manual: opts.manual === true, sessions: digest.count, events: digest.events });
    child.on("error", () => {
      patchRunMeta(staging, { endedAt: Date.now(), exitCode: -1 });
      opts.onExit?.(launch);
    });
    child.on("exit", (code, signal) => {
      patchRunMeta(staging, { endedAt: Date.now(), exitCode: code, signal });
      try {
        opts.onExit?.(launch);
      } catch {
        // listener failures never matter here
      }
    });
    child.unref();
    return launch;
  } catch {
    return null;
  }
}
