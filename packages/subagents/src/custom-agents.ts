/**
 * @pi-unipi/subagents — Custom agent loader
 *
 * Discovers agent types from:
 * - <workspace>/.unipi/config/agents/*.md (project, highest priority)
 * - ~/.unipi/config/agents/*.md (global)
 * - packages/subagents/agents/*.md (builtin, lowest priority — pi-subagents parity)
 *
 * Recursive subdirectory discovery: project wins name collisions.
 */

import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Backup a corrupted file by renaming to .bak */
function backupCorrupted(filePath: string): void {
  const backupPath = filePath + ".bak";
  try {
    renameSync(filePath, backupPath);
  } catch {
    // If backup fails, just leave it
  }
}

/** Get project agents directory. */
function getProjectAgentsDir(cwd: string): string {
  return join(cwd, ".unipi", "config", "agents");
}

/** Get global agents directory. */
function getGlobalAgentsDir(): string {
  return join(homedir(), ".unipi", "config", "agents");
}

/** All known built-in tool names. */
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Known frontmatter fields (pi-subagents KNOWN_FIELDS + our unipi extensions). */
const KNOWN_FIELDS = new Set([
  "name",
  "display_name",
  "description",
  "alias",
  "aliases",
  "tools",
  "disallowed_tools",
  "model",
  "fallbackModels",
  "thinking",
  "extensions",
  "skills",
  "max_turns",
  "systemPromptMode",
  "prompt_mode",
  "inheritProjectContext",
  "inheritSkills",
  "defaultContext",
  "async",
  "run_in_background",
  "isolated",
  "timeoutMs",
  "toolTimeoutMs",
  "turnBudget",
  "skill",
  "skillPath",
  "subagentOnlyExtensions",
  "output",
  "outputMode",
  "defaultReads",
  "defaultProgress",
  "interactive",
  "maxSubagentDepth",
  "completionGuard",
  "toolBudget",
  "memory",
  "enabled",
  "runner",
]);

/** Parse a comma-separated frontmatter list (reference parseFrontmatterList). */
function parseList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
}

/** Default systemPromptMode per reference (delegate appends, others replace). */
function defaultSystemPromptMode(name: string): "replace" | "append" {
  return name === "delegate" || name === "explore" ? "append" : "replace";
}

/** Default inheritProjectContext per reference (delegate only). */
function defaultInheritProjectContext(name: string): boolean {
  return name === "delegate";
}

/** Parse a boolean-ish frontmatter value ("true"/"false" strings or actual booleans). */
function parseBool(raw: unknown): boolean | undefined {
  if (raw === "true" || raw === true) return true;
  if (raw === "false" || raw === false) return false;
  return undefined;
}

/** Parse a positive-integer frontmatter value with a visible error. */
function parsePositiveInt(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error(`${label} must be a positive integer no greater than 2147483647 (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

/** Directory names pruned during recursive discovery. */
const DISCOVERY_PRUNED_DIR_NAMES = new Set(["node_modules", ".git", ".pi", ".unipi"]);

/** List agent .md files recursively under a directory (skips .chain.md, prunes node_modules). */
function listAgentFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return files;
  }
  for (const entry of entries) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!DISCOVERY_PRUNED_DIR_NAMES.has(entry.name)) {
        files.push(...listAgentFilesRecursive(filePath));
      }
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith(".md") || entry.name.endsWith(".chain.md")) continue;
    files.push(filePath);
  }
  return files;
}

/** Builtin agent definition files shipped in packages/subagents/agents/. */
const BUILTIN_AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/** Frontmatter fields stored as-is on the config for later phases. */
function collectExtraFields(frontmatter: Record<string, unknown>): Record<string, string> | undefined {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_FIELDS.has(key)) extra[key] = String(value);
  }
  return Object.keys(extra).length ? extra : undefined;
}

/**
 * Load a single agent from a .md file. Accepts both our legacy unipi frontmatter
 * (display_name, disallowed_tools, prompt_mode, max_turns, run_in_background,
 * isolated, enabled) and the pi-subagents reference frontmatter (aliases,
 * systemPromptMode, inheritProjectContext, defaultContext, timeoutMs, ...).
 */
function loadAgentFromFile(filePath: string, source: "project" | "global" | "builtin"): AgentConfig | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter || typeof frontmatter !== "object") {
      return null;
    }
    const fm = frontmatter as Record<string, unknown>;

    // Name: frontmatter name wins; else filename (our legacy convention).
    const name =
      (typeof fm.name === "string" && fm.name.trim()) ||
      filePath.split("/").pop()?.replace(/\.md$/, "") ||
      "unknown";

    const description =
      (typeof fm.description === "string" && fm.description) || `${name} agent`;

    // Tools: comma-separated string; unknown tool names kept (mcp/extension tools).
    const toolsList = parseList(fm.tools);
    const builtinToolNames = toolsList ?? [...BUILTIN_TOOL_NAMES];

    const aliases = parseList(fm.aliases ?? fm.alias);

    // Prompt mode: reference systemPromptMode or our legacy prompt_mode.
    const promptModeRaw = fm.systemPromptMode ?? fm.prompt_mode;
    const promptMode: "replace" | "append" =
      promptModeRaw === "replace" || promptModeRaw === "append"
        ? promptModeRaw
        : defaultSystemPromptMode(name);

    const inheritProjectContext =
      parseBool(fm.inheritProjectContext) ?? defaultInheritProjectContext(name);
    const inheritSkills = parseBool(fm.inheritSkills) ?? false;

    const defaultContext =
      fm.defaultContext === "fork" ? "fork" : fm.defaultContext === "fresh" ? "fresh" : undefined;

    const timeoutMs = parsePositiveInt(fm.timeoutMs, `Agent '${name}' timeoutMs`);
    const toolTimeoutMs = parsePositiveInt(fm.toolTimeoutMs, `Agent '${name}' toolTimeoutMs`);
    const maxSubagentDepth =
      fm.maxSubagentDepth !== undefined && fm.maxSubagentDepth !== null && fm.maxSubagentDepth !== ""
        ? parsePositiveInt(fm.maxSubagentDepth, `Agent '${name}' maxSubagentDepth`)
        : undefined;

    let defaultAsync: boolean | undefined;
    if (fm.async !== undefined) {
      const parsed = parseBool(fm.async);
      if (parsed === undefined) {
        throw new Error(`Agent '${name}' has invalid async frontmatter; expected true or false.`);
      }
      defaultAsync = parsed;
    }

    let outputMode: "inline" | "file-only" | undefined;
    if (fm.outputMode !== undefined && fm.outputMode !== "") {
      if (fm.outputMode === "inline" || fm.outputMode === "file-only") outputMode = fm.outputMode;
      else throw new Error(`Agent '${name}' has invalid outputMode frontmatter; expected 'inline' or 'file-only'.`);
    }

    return {
      name,
      displayName: (fm.display_name as string | undefined) ?? undefined,
      description,
      ...(aliases?.length ? { aliases } : {}),
      builtinToolNames,
      disallowedTools: parseList(fm.disallowed_tools),
      extensions: fm.extensions !== false,
      skills: fm.skills !== false,
      ...(parseList(fm.skillPath)?.length ? { skillPath: parseList(fm.skillPath) } : {}),
      model: (fm.model as string | undefined) || undefined,
      ...(parseList(fm.fallbackModels)?.length ? { fallbackModels: parseList(fm.fallbackModels) } : {}),
      thinking: fm.thinking as any,
      maxTurns: parsePositiveInt(fm.max_turns, `Agent '${name}' max_turns`),
      systemPrompt: body.trim(),
      promptMode,
      inheritProjectContext,
      inheritSkills,
      ...(defaultContext !== undefined ? { defaultContext } : {}),
      ...(defaultAsync !== undefined ? { runInBackground: defaultAsync } : {}),
      runInBackground: (fm.run_in_background as boolean | undefined) ?? defaultAsync,
      isolated: fm.isolated as boolean | undefined,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
      ...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
      ...(outputMode !== undefined ? { outputMode } : {}),
      ...(typeof fm.output === "string" && fm.output ? { output: fm.output } : {}),
      ...(parseList(fm.defaultReads)?.length ? { defaultReads: parseList(fm.defaultReads) } : {}),
      ...(parseBool(fm.defaultProgress) !== undefined ? { defaultProgress: parseBool(fm.defaultProgress) } : {}),
      ...(typeof fm.memory === "string" && fm.memory.trim()
        ? { memory: fm.memory.trim() as AgentConfig["memory"] }
        : undefined),
      enabled: fm.enabled !== false,
      source,
      ...(collectExtraFields(fm) ? { extraFields: collectExtraFields(fm) } : {}),
    };
  } catch (err) {
    // Corrupted file — backup and skip (builtin files rethrow: they ship with us)
    if (source === "builtin") throw err;
    backupCorrupted(filePath);
    return null;
  }
}

/**
 * Load builtin definition-file agents from packages/subagents/agents/.
 * Loaded at the LOWEST priority: user/global and project agents override by name.
 */
export function loadBuiltinFileAgents(): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  for (const filePath of listAgentFilesRecursive(BUILTIN_AGENTS_DIR)) {
    const agent = loadAgentFromFile(filePath, "builtin");
    if (agent) agents.set(agent.name, agent);
  }
  return agents;
}

/**
 * Load all custom agents from project and global directories.
 * Priority: project > global > builtin (code BUILTIN_CONFIGS last).
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();

  // Builtin file agents first (lowest priority)
  for (const [name, agent] of loadBuiltinFileAgents()) {
    agents.set(name, agent);
  }

  // Global agents (override builtins)
  const globalDir = getGlobalAgentsDir();
  if (existsSync(globalDir)) {
    for (const filePath of listAgentFilesRecursive(globalDir)) {
      const agent = loadAgentFromFile(filePath, "global");
      if (agent) {
        agents.set(agent.name, agent);
      }
    }
  }

  // Project agents (override global + builtin)
  const projectDir = getProjectAgentsDir(cwd);
  if (existsSync(projectDir)) {
    for (const filePath of listAgentFilesRecursive(projectDir)) {
      const agent = loadAgentFromFile(filePath, "project");
      if (agent) {
        agents.set(agent.name, agent);
      }
    }
  }

  return agents;
}
