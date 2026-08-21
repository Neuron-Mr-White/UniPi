/**
 * @pi-unipi/subagents — Child pi CLI argument builder
 *
 * Ported from pi-subagents src/runs/shared/pi-args.ts (buildPiArgs core).
 * Env overrides use OUR prefix: UNIPI_SUBAGENT_TASK_DELIVERY,
 * UNIPI_SUBAGENT_CHILD, UNIPI_SUBAGENT_PARENT_SESSION. Task delivery follows
 * the reference: 'auto' passes short tasks inline and writes tasks over
 * 8000 chars to a temp task.md referenced as @<path> (EDR workaround); 'file'
 * always uses the file. Zero-activity SIGKILL escalation to file delivery
 * lives in the runner (Phase 3 next slice).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const SUBAGENT_TASK_DELIVERY_ENV = "UNIPI_SUBAGENT_TASK_DELIVERY";
export const SUBAGENT_CHILD_ENV = "UNIPI_SUBAGENT_CHILD";
export const SUBAGENT_PARENT_SESSION_ENV = "UNIPI_SUBAGENT_PARENT_SESSION";
export const SUBAGENT_CHILD_AGENT_ENV = "UNIPI_SUBAGENT_CHILD_AGENT";
export const SUBAGENT_RUN_ID_ENV = "UNIPI_SUBAGENT_RUN_ID";

const TASK_ARG_LIMIT = 8000;

export type SubagentTaskDelivery = "auto" | "file";

export function resolveSubagentTaskDelivery(
  env: NodeJS.ProcessEnv = process.env,
): SubagentTaskDelivery {
  return env[SUBAGENT_TASK_DELIVERY_ENV]?.trim().toLowerCase() === "file" ? "file" : "auto";
}

function shouldDeliverTaskViaFile(task: string, delivery: SubagentTaskDelivery): boolean {
  return delivery === "file" || task.length > TASK_ARG_LIMIT;
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BuildPiArgsInput {
  /** Extra CLI args before the task (e.g. ['--print', mode flags]). */
  baseArgs: string[];
  task: string;
  /** pi flags */
  sessionFile?: string;
  sessionDir?: string;
  noSession?: boolean;
  model?: string;
  thinking?: string | false;
  tools?: string[];
  extensions?: string[];
  systemPrompt?: string;
  systemPromptMode?: "replace" | "append";
  promptFileStem?: string;
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  cwd?: string;
  taskDelivery?: SubagentTaskDelivery;
  /** Child identification env (parent session targeting for Phase 6 intercom). */
  parentSessionId?: string;
  childAgentName?: string;
  runId?: string;
}

export interface BuildPiArgsResult {
  args: string[];
  env: Record<string, string | undefined>;
  /** Temp dir holding prompt/task files; caller cleans up after exit. */
  tempDir: string;
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
  const args = [...input.baseArgs];

  // ---- Session ----
  if (input.sessionFile) {
    fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
    args.push("--session", input.sessionFile);
  } else {
    if (input.noSession) args.push("--no-session");
    if (input.sessionDir) {
      fs.mkdirSync(input.sessionDir, { recursive: true });
      args.push("--session-dir", input.sessionDir);
    }
  }

  // ---- Model (+ thinking suffix) ----
  if (input.model) {
    const thinking = input.thinking;
    const modelArg =
      thinking && thinking !== "false" && thinking !== "off"
        ? `${input.model}--thinking=${thinking}`
        : input.model;
    args.push("--model", modelArg);
  }

  // ---- Tools ----
  if (input.tools !== undefined) {
    if (input.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", input.tools.join(","));
  }

  // ---- Extensions ----
  if (input.extensions !== undefined) {
    args.push("--no-extensions");
    for (const extPath of input.extensions) args.push("--extension", extPath);
  }

  // ---- Project context / skills ----
  if (!input.inheritProjectContext) args.push("--no-context-files");
  if (!input.inheritSkills) args.push("--no-skills");

  // ---- System prompt via temp file ----
  let tempDir: string | undefined;
  if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-subagent-"));
    const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
    const promptPath = path.join(tempDir, `${stem}.md`);
    const taggedPrompt = input.childAgentName
      ? `<active_agent name="${escapeXmlAttr(input.childAgentName)}"/>\n\n${input.systemPrompt}`
      : input.systemPrompt;
    fs.writeFileSync(promptPath, taggedPrompt, { mode: 0o600 });
    args.push(
      input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      promptPath,
    );
  }

  // ---- Task delivery (EDR-safe) ----
  if (shouldDeliverTaskViaFile(input.task, input.taskDelivery ?? resolveSubagentTaskDelivery())) {
    if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-subagent-"));
    const taskFilePath = path.join(tempDir, "task.md");
    fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
    args.push(`@${taskFilePath}`);
  } else {
    args.push(`Task: ${input.task}`);
  }

  // ---- Child env ----
  const env: Record<string, string | undefined> = {};
  env[SUBAGENT_CHILD_ENV] = "1";
  if (input.parentSessionId) env[SUBAGENT_PARENT_SESSION_ENV] = input.parentSessionId;
  if (input.childAgentName) env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
  if (input.runId) env[SUBAGENT_RUN_ID_ENV] = input.runId;

  return { args, env, tempDir: tempDir ?? "" };
}

export function cleanupTempDir(tempDir: string | null | undefined): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}
