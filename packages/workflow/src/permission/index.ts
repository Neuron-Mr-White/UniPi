/**
 * Permission modes — the tool-call gate.
 *
 * Every tool call is classified (read-only, workspace write, bash, other) and
 * gated by the active mode. In `auto`, an unrecognized bash command is judged by
 * jev (one Decision-model call) instead of prompting; anything destructive or
 * ambiguous always asks. Without a UI nothing prompts: it behaves like `full`,
 * except saved deny rules and dangerous patterns, which are blocked outright.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  UNIPI_EVENTS,
  askJev,
  emitEvent,
  readJudgeJevSettings,
  registerCommandRunner,
  runCommandByName,
  setSharedPermissionMode,
} from "@pi-unipi/core";
import { decideToolCall, type Decision, type JevRisk } from "./decide.js";
import { requestApproval } from "./prompt.js";
import {
  clearPermissionRules,
  readPermissionSettings,
  registerPermissionSettings,
  writePermissionMode,
  type PermissionMode,
} from "./settings.js";

const MODES: PermissionMode[] = ["ask", "auto", "full"];

export interface PermissionController {
  /** Current mode (re-read from settings so hub edits apply immediately). */
  mode(cwd: string): PermissionMode;
  cycle(cwd: string): PermissionMode;
  set(mode: PermissionMode, cwd: string): void;
  /** Gate one tool call. `planFile` routes plan-mode enforcement first. */
  decide(
    input: { toolName: string; subject: string },
    ctx: ExtensionContext,
  ): Promise<Decision>;
  /** Approve via the interactive prompt (used by the gate). */
  approve(
    request: { toolName: string; summary: string; reason: string; subject: string },
    ctx: ExtensionContext,
  ): Promise<{ block: boolean; reason?: string }>;
}

function debugLog(line: string): void {
  if (process.env.UNIPI_DEBUG_PERMISSION !== "1") return;
  try {
    const dir = `${homedir()}/.unipi/logs`;
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/permission.log`, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort
  }
}

/** One jev risk question; null (fail-open → prompt) on error, timeout or no key. */
export async function askJevRisk(cwd: string, state: string): Promise<JevRisk | null> {
  const settings = readJudgeJevSettings(cwd);
  const answers = await askJev({
    state,
    questions: {
      risk: {
        type: "choice",
        instructions: "Would running this shell command be safe without asking the user first?",
        criteria: {
          safe: "Routine development command with no destructive or external side effects beyond the project (build, test, lint, install deps, run scripts, git add/commit)",
          needs_approval:
            "Could modify things outside the project, publish/deploy, delete data, change system/global config, or spend money",
          dangerous: "Destructive, irreversible, exfiltrates secrets, or escalates privileges",
        },
      },
    },
    settings,
    env: process.env,
  });
  const answer = answers?.risk;
  const choice = typeof answer?.choice === "string" ? answer.choice : null;
  if (!choice) return null;
  return { choice, confidence: typeof answer?.confidence === "number" ? answer.confidence : 0 };
}

export function createPermissionController(pi: ExtensionAPI): PermissionController {
  function mode(cwd: string): PermissionMode {
    return readPermissionSettings(cwd).mode;
  }

  function set(next: PermissionMode, cwd: string): void {
    writePermissionMode(next, cwd);
    setSharedPermissionMode(next);
    emitEvent(pi, UNIPI_EVENTS.PERMISSION_MODE_CHANGED, { mode: next });
    debugLog(`mode set to ${next}`);
  }

  async function decide(
    input: { toolName: string; subject: string },
    ctx: ExtensionContext,
  ): Promise<Decision> {
    const settings = readPermissionSettings(ctx.cwd);
    const decision = await decideToolCall(input, {
      mode: settings.mode,
      jevJudge: settings.jevJudge,
      jevConfidence: settings.jevConfidence,
      rules: settings.rules,
      cwd: ctx.cwd,
      tmpdir: tmpdir(),
      hasUI: ctx.hasUI,
      askJevRisk: (state) => askJevRisk(ctx.cwd, state),
    });
    debugLog(
      `decision tool=${input.toolName} mode=${settings.mode} action=${decision.action} ` +
      `reason=${JSON.stringify(decision.reason)} subject=${JSON.stringify(input.subject.slice(0, 200))}`,
    );
    return decision;
  }

  async function approve(
    request: { toolName: string; summary: string; reason: string; subject: string },
    ctx: ExtensionContext,
  ): Promise<{ block: boolean; reason?: string }> {
    const settings = readPermissionSettings(ctx.cwd);
    const outcome = await requestApproval(ctx, request, settings);
    if (outcome.decision === "allow") {
      debugLog(`approved tool=${request.toolName} rule=${outcome.savedRule?.pattern ?? "-"}`);
      return { block: false };
    }
    const reason = `Blocked by permission (user denied)${outcome.note ? `: ${outcome.note}` : ""}`;
    debugLog(`denied tool=${request.toolName} note=${JSON.stringify(outcome.note ?? "")}`);
    return { block: true, reason };
  }

  return {
    mode,
    set,
    decide,
    approve,
    cycle(cwd: string): PermissionMode {
      const current = mode(cwd);
      const next = MODES[(MODES.indexOf(current) + 1) % MODES.length]!;
      set(next, cwd);
      return next;
    },
  };
}

/** Command + shortcut + hub wiring. */
export function registerPermissionModes(pi: ExtensionAPI, controller: PermissionController): void {
  registerPermissionSettings();

  pi.registerCommand("unipi:permission", {
    description: "Permission mode — ask · auto (jev-judged) · full",
    getArgumentCompletions: (prefix: string) => {
      const needle = (prefix ?? "").trim().toLowerCase();
      const items = MODES.filter((m) => m.startsWith(needle)).map((m) => ({
        value: m,
        label: m,
        description:
          m === "ask"
            ? "Prompt before every write, bash call and other tool"
            : m === "auto"
              ? "Read-only and workspace writes run; jev judges ambiguous bash (default)"
              : "Run everything except saved deny rules and dangerous patterns",
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const requested = (args ?? "").trim().toLowerCase();
      if (!requested) {
        const current = controller.mode(ctx.cwd);
        ctx.ui.notify(`Permission mode: ${current}`, "info");
        return;
      }
      if (!MODES.includes(requested as PermissionMode)) {
        ctx.ui.notify(`Unknown permission mode "${requested}" — use ask, auto or full`, "warning");
        return;
      }
      controller.set(requested as PermissionMode, ctx.cwd);
      ctx.ui.notify(`Permission mode: ${requested}`, "info");
    },
  });

  pi.registerShortcut("alt+m" as never, {
    description: "Cycle permission mode (ask → auto → full)",
    handler: async (ctx) => {
      const next = controller.cycle(ctx.cwd);
      const labels: Record<PermissionMode, string> = {
        ask: "ask (always prompt)",
        auto: "auto (jev judges ambiguous bash)",
        full: "full (only deny rules block)",
      };
      ctx.ui.notify(`Permission mode: ${labels[next]}`, "info");
    },
  });

  registerCommandRunner("unipi:permission-clear-rules", async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    const cwd = context?.cwd ?? process.cwd();
    const removed = clearPermissionRules(cwd);
    context?.ui.notify(
      removed === 0 ? "No saved permission rules" : `Cleared ${removed} permission rule${removed === 1 ? "" : "s"}`,
      "info",
    );
  });

  // Hub-edited mode must reach the footer even when changed outside the command.
  pi.on("session_start", async (_event, ctx) => {
    const settings = readPermissionSettings(ctx.cwd);
    registerPermissionSettings(ctx.cwd);
    // The holder is what the footer reads (its event subscription attaches after
    // this handler runs); the event stays for other consumers.
    setSharedPermissionMode(settings.mode);
    emitEvent(pi, UNIPI_EVENTS.PERMISSION_MODE_CHANGED, { mode: settings.mode });
  });
}

export { runCommandByName };
