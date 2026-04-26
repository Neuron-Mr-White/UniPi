/**
 * @pi-unipi/subagents — System prompt builder
 */

import type { AgentConfig } from "./types.js";

/**
 * Build system prompt for an agent.
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: { isGitRepo: boolean; branch: string; platform: string },
  parentSystemPrompt: string,
): string {
  if (config.promptMode === "append") {
    // Append mode: parent prompt + agent additions
    return [
      parentSystemPrompt,
      "",
      "---",
      "",
      `## Agent Role: ${config.displayName ?? config.name}`,
      config.systemPrompt,
    ].join("\n");
  }

  // Replace mode: standalone prompt
  return [
    `# ${config.displayName ?? config.name}`,
    "",
    config.systemPrompt,
    "",
    "---",
    "",
    `Working directory: ${cwd}`,
    `Git: ${env.isGitRepo ? `${env.branch} on ${env.platform}` : "not a git repo"}`,
  ].join("\n");
}
