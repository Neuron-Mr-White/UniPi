/**
 * The permission decision matrix — pure and injected, so the whole mode × tool
 * behaviour is testable without pi or the network.
 */

import { basename, resolve, sep } from "node:path";
import { classifyBash } from "./bash.js";
import { matchRule, type PermissionRule } from "./rules.js";
import type { PermissionMode } from "./settings.js";

/**
 * Tools that cannot mutate the workspace, the machine, or the session — always
 * allowed. Everything else is classified below; unlisted read-only tools still
 * run in `auto`/`full`, they would only prompt in `ask` mode.
 */
export const READ_ONLY_TOOLS = new Set([
  // pi core
  "read", "grep", "find", "ls",
  // unipi read-only surfaces
  "ffgrep", "fffind", "session_recall", "ask_user",
  "memory_search", "memory_list", "global_memory_search", "global_memory_list",
  "web_search", "multi_web_content_read", "web_llm_summarize",
  "bg_status", "bg_logs", "bg_result", "get_helper_result",
  "compactor_stats", "compactor_doctor", "context_budget", "ctx_env", "ctx_budget",
  "omniroute_status", "loop_status", "swarm_status", "view_agent_graph", "get_goal",
  "read_subagent",
]);

export type Decision =
  | { action: "allow"; reason: string }
  | { action: "ask"; reason: string; subject: string }
  | { action: "block"; reason: string };

export interface JevRisk {
  choice: string;
  confidence: number;
}

export interface DecideDeps {
  mode: PermissionMode;
  jevJudge: boolean;
  jevConfidence: number;
  rules: readonly PermissionRule[];
  cwd: string;
  tmpdir: string;
  hasUI: boolean;
  /** Injected jev risk judgement; absent = jev unavailable. */
  askJevRisk?: (state: string) => Promise<JevRisk | null>;
}

export interface ToolCallInput {
  toolName: string;
  /** bash command, write/edit path, or an args summary for other tools. */
  subject: string;
}

/** The jev `state` payload for one command. */
export function jevRiskState(cwd: string, command: string): string {
  return `cwd: ${basename(cwd)}\ncommand: ${command.slice(0, 1500)}`;
}

function isInsidePath(target: string, root: string): boolean {
  if (!root) return false;
  const normalizedRoot = resolve(root);
  const normalized = resolve(target);
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + sep);
}

function resolveToolPath(subject: string, cwd: string): string {
  return resolve(cwd, subject);
}

/**
 * Classify one tool call. Plan mode is enforced separately and runs BEFORE this
 * gate (see `@pi-unipi/workflow` plan mode).
 */
export async function decideToolCall(input: ToolCallInput, deps: DecideDeps): Promise<Decision> {
  const tool = input.toolName;
  const isWrite = tool === "write" || tool === "edit";
  const subject = isWrite ? resolveToolPath(input.subject, deps.cwd) : input.subject;

  // 1. Saved rules first — deny shadows everything, in every mode.
  const rule = matchRule(deps.rules, tool, subject);
  if (rule?.decision === "deny") {
    return { action: "block", reason: `Blocked by permission (saved deny rule: ${rule.pattern})` };
  }
  if (rule?.decision === "allow") {
    return { action: "allow", reason: `saved allow rule: ${rule.pattern}` };
  }

  // 2. Read-only tools.
  if (READ_ONLY_TOOLS.has(tool)) return { action: "allow", reason: "read-only tool" };

  // 3. write / edit — inside the workspace or the temp dir is fine outside ask mode.
  if (isWrite) {
    const inside = isInsidePath(subject, deps.cwd) || isInsidePath(subject, deps.tmpdir);
    if (inside && deps.mode !== "ask") return { action: "allow", reason: "inside the workspace" };
    if (!deps.hasUI) return { action: "allow", reason: "no UI — full behaviour" };
    return {
      action: "ask",
      reason: inside ? "ask mode" : "writes outside the workspace",
      subject,
    };
  }

  // 4. bash.
  if (tool === "bash") {
    const verdict = classifyBash(subject);

    if (verdict.kind === "dangerous") {
      if (!deps.hasUI) {
        return {
          action: "block",
          reason: `Blocked by permission (dangerous, no UI to confirm): ${verdict.reason}`,
        };
      }
      if (deps.mode === "full") return { action: "allow", reason: `full mode · ${verdict.reason}` };
      return { action: "ask", reason: `dangerous: ${verdict.reason}`, subject };
    }

    if (verdict.kind === "kanboard") {
      if (deps.mode === "ask" && deps.hasUI) return { action: "ask", reason: "ask mode", subject };
      return { action: "allow", reason: verdict.reason };
    }

    if (verdict.kind === "read_only") {
      if (deps.mode === "ask" && deps.hasUI) return { action: "ask", reason: "ask mode", subject };
      return { action: "allow", reason: verdict.reason };
    }

    if (deps.mode === "full") return { action: "allow", reason: "full mode" };

    if (deps.mode === "auto" && deps.jevJudge) {
      const risk = deps.askJevRisk ? await deps.askJevRisk(jevRiskState(deps.cwd, subject)) : null;
      if (risk && risk.choice === "safe" && risk.confidence >= deps.jevConfidence) {
        return { action: "allow", reason: `jev: safe ${risk.confidence.toFixed(2)}` };
      }
      const label = risk ? `jev: ${risk.choice} ${risk.confidence.toFixed(2)}` : "jev: unavailable";
      if (!deps.hasUI) return { action: "allow", reason: `no UI — full behaviour (${label})` };
      return { action: "ask", reason: label, subject };
    }

    if (!deps.hasUI) return { action: "allow", reason: "no UI — full behaviour" };
    return { action: "ask", reason: deps.mode === "auto" ? "auto mode (jev off)" : "ask mode", subject };
  }

  // 5. Everything else (MCP, subagents, background tasks…).
  if (deps.mode === "ask" && deps.hasUI) {
    return { action: "ask", reason: "ask mode", subject: input.subject.slice(0, 120) };
  }
  return { action: "allow", reason: `${deps.mode} mode` };
}
