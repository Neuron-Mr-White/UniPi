/**
 * @pi-unipi/subagents — Agent profiles (built-ins + custom .md agents)
 *
 * Built-ins: `subagent_explore` (read-only, cheaper default model) and
 * `subagent_general` (full tools minus nesting/lead tools, parent's model).
 * Custom agents: markdown + YAML frontmatter under
 *   ~/.unipi/config/agents/ and <workspace>/.unipi/config/agents/
 *   (<name>.md or <name>/AGENT.md|AGENTS.md|agent.md|agents.md, project wins).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentProfile {
  /** Internal id (e.g. "subagent_explore", or the custom name). */
  id: string;
  /** One-line description shown in the profile list. */
  description: string;
  /** Tool allowlist → `--tools a,b` (undefined = all except nesting tools). */
  tools?: string[];
  /** Model override (key `provider/id`, or resolved later). */
  model?: string;
  /** Thinking level override. */
  thinking?: string;
  /** Max nesting depth for this agent's subtree (default 1). */
  maxNesting?: number;
  /** Appended system prompt. */
  systemPrompt: string;
  /** Source: builtin | global | project. */
  source: "builtin" | "global" | "project";
}

export const EXPLORE_TOOLS = ["read", "grep", "find", "ls", "web_search", "memory_search", "memory_list"] as const;
export const EXCLUDED_NESTING_TOOLS = ["sidekick", "read_subagent", "run_subagent"] as const;

const EXPLORE_PROMPT =
  "You are a read-only exploration subagent. Investigate the task using only read and search tools; you cannot edit files or run commands. Report concrete findings with file paths and line numbers, and say clearly what you could not determine.";

const GENERAL_PROMPT =
  "You are a general-purpose subagent working on a task delegated by a parent agent. Complete the task, verify your work, and finish with a concise report: what you did, files changed, how you verified it, and anything left open. Do not talk to the user; your final message goes to the parent agent.";

export function builtinProfiles(): AgentProfile[] {
  return [
    { id: "subagent_explore", description: "Read-only codebase exploration and research.", tools: [...EXPLORE_TOOLS], systemPrompt: EXPLORE_PROMPT, source: "builtin" },
    { id: "subagent_general", description: "General-purpose tasks including code changes.", systemPrompt: GENERAL_PROMPT, source: "builtin" },
  ];
}

const DIR_CANDIDATES = ["AGENT.md", "AGENTS.md", "agent.md", "agents.md"] as const;

function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return undefined;
}

function loadAgentFile(path: string, source: "global" | "project", pathName: string): { profile: AgentProfile } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { error: String(e) };
  }
  const { frontmatter, body } = parseFrontmatter(raw) as { frontmatter: Record<string, unknown>; body: string };
  const id = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : pathName;
  return {
    profile: {
      id,
      description: typeof frontmatter.description === "string" ? frontmatter.description : id,
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
      tools: parseToolList(frontmatter["allowed-tools"] ?? frontmatter.tools),
      maxNesting: typeof frontmatter["max-nesting"] === "number" ? frontmatter["max-nesting"] : undefined,
      systemPrompt: body.trim(),
      source,
    },
  };
}

function agentsIn(dir: string, source: "global" | "project", warnings: string[]): Map<string, AgentProfile> {
  const out = new Map<string, AgentProfile>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = basename(entry.name, ".md");
      const r = loadAgentFile(join(dir, entry.name), source, name);
      if ("error" in r) warnings.push(`${entry.name}: ${r.error}`);
      else out.set(r.profile.id, r.profile);
    } else if (entry.isDirectory()) {
      for (const cand of DIR_CANDIDATES) {
        const file = join(dir, entry.name, cand);
        if (!existsSync(file)) continue;
        const r = loadAgentFile(file, source, entry.name);
        if ("error" in r) warnings.push(`${entry.name}/${cand}: ${r.error}`);
        else out.set(r.profile.id, r.profile);
        break;
      }
    }
  }
  return out;
}

export interface LoadedProfiles {
  profiles: AgentProfile[];
  warnings: string[];
}

/** Load all profiles: built-ins first, then global customs, then project overrides. */
export function loadProfiles(cwd: string, home = homedir()): LoadedProfiles {
  const builtins = builtinProfiles();
  const builtinIds = new Set(builtins.map((b) => b.id));
  const warnings: string[] = [];
  const merged = new Map<string, AgentProfile>();

  const load = (dir: string, source: "global" | "project") => {
    for (const [id, profile] of agentsIn(dir, source, warnings)) {
      if (builtinIds.has(id)) {
        warnings.push(`${id}: custom agent shadows a built-in name — skipped`);
        continue;
      }
      merged.set(id, profile);
    }
  };
  load(join(home, ".unipi", "config", "agents"), "global");
  load(join(cwd, ".unipi", "config", "agents"), "project");

  return { profiles: [...builtins, ...merged.values()], warnings };
}
