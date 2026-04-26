/**
 * @pi-unipi/subagents — Custom agent loader
 *
 * Discovers agent types from:
 * - <workspace>/.unipi/config/agents/*.md (project, highest priority)
 * - ~/.unipi/config/agents/*.md (global)
 */

import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./types.js";

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

/**
 * Load a single agent from a .md file.
 */
function loadAgentFromFile(filePath: string, source: "project" | "global"): AgentConfig | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter || typeof frontmatter !== "object") {
      return null;
    }

    const name = filePath.split("/").pop()?.replace(/\.md$/, "") ?? "unknown";

    // Parse tools from comma-separated string
    const toolsStr = (frontmatter as any).tools as string | undefined;
    const builtinToolNames = toolsStr
      ? toolsStr.split(",").map((t) => t.trim()).filter((t) => BUILTIN_TOOL_NAMES.includes(t))
      : [...BUILTIN_TOOL_NAMES];

    return {
      name,
      displayName: (frontmatter as any).display_name as string | undefined,
      description: ((frontmatter as any).description as string) ?? `${name} agent`,
      builtinToolNames,
      disallowedTools: ((frontmatter as any).disallowed_tools as string | undefined)
        ?.split(",")
        .map((t) => t.trim()),
      extensions: (frontmatter as any).extensions !== false,
      skills: (frontmatter as any).skills !== false,
      model: (frontmatter as any).model as string | undefined,
      thinking: (frontmatter as any).thinking as any,
      maxTurns: (frontmatter as any).max_turns as number | undefined,
      systemPrompt: body.trim(),
      promptMode: ((frontmatter as any).prompt_mode as "replace" | "append") ?? "replace",
      inheritContext: (frontmatter as any).inherit_context as boolean | undefined,
      runInBackground: (frontmatter as any).run_in_background as boolean | undefined,
      isolated: (frontmatter as any).isolated as boolean | undefined,
      enabled: (frontmatter as any).enabled !== false,
      source,
    };
  } catch {
    // Corrupted file — backup and skip
    backupCorrupted(filePath);
    return null;
  }
}

/**
 * Load all custom agents from project and global directories.
 * Project agents override global agents with the same name.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();

  // Load global agents first
  const globalDir = getGlobalAgentsDir();
  if (existsSync(globalDir)) {
    const files = readdirSync(globalDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const agent = loadAgentFromFile(join(globalDir, file), "global");
      if (agent) {
        agents.set(agent.name, agent);
      }
    }
  }

  // Load project agents (overrides global)
  const projectDir = getProjectAgentsDir(cwd);
  if (existsSync(projectDir)) {
    const files = readdirSync(projectDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const agent = loadAgentFromFile(join(projectDir, file), "project");
      if (agent) {
        agents.set(agent.name, agent);
      }
    }
  }

  return agents;
}
