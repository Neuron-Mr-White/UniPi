/**
 * @unipi/core — Sandbox module
 *
 * Defines tool access levels for workflow commands.
 * Used with pi.setActiveTools() to enforce restrictions.
 */

import { WORKFLOW_COMMANDS } from "./constants.js";

/** Sandbox levels */
export type SandboxLevel = "read_only" | "brainstorm" | "write_unipi" | "review" | "full";

/**
 * Built-in workflow tools used when no active tool list is supplied.
 *
 * Workflow commands should normally call filterToolsForLevel() with the current
 * active tool list. That keeps safe extension tools (memory, ask-user, web,
 * notify, etc.) available while removing only tools that violate the sandbox.
 */
const FALLBACK_TOOLS: Record<SandboxLevel, readonly string[]> = {
  /** Only read-only file tools — no bash, no write, no edit */
  read_only: ["read", "grep", "find", "ls"],
  /** Read + constrained write + bash (setup only) — only to .unipi/docs/specs/ by instruction */
  brainstorm: ["read", "grep", "find", "ls", "write", "bash"],
  /** Read + write/edit + file discovery — no bash */
  write_unipi: ["read", "write", "edit", "grep", "find", "ls"],
  /** Read + write/edit + bash for git/checks — no code editing by instruction */
  review: ["read", "write", "edit", "grep", "find", "ls", "bash"],
  /** Full workflow access */
  full: ["read", "write", "edit", "bash"],
};

/** Tools that are removed from the current active tool set at each level. */
const BLOCKED_TOOLS: Record<SandboxLevel, readonly string[]> = {
  /** Read-only workflows must not mutate files or run shell commands. */
  read_only: ["write", "edit", "bash"],
  /** Brainstorm may write specs and run limited setup commands, but should not edit existing files. */
  brainstorm: ["edit"],
  /** Planning/docs workflows may write .unipi docs, but should not run shell commands. */
  write_unipi: ["bash"],
  /** Review workflows rely on command instructions to constrain writes to reviewer remarks. */
  review: [],
  /** Full workflows do not filter active tools. */
  full: [],
};

/** Command to sandbox level mapping */
const COMMAND_SANDBOX: Record<string, SandboxLevel> = {
  [WORKFLOW_COMMANDS.BRAINSTORM]: "brainstorm",
  [WORKFLOW_COMMANDS.PLAN]: "write_unipi",
  [WORKFLOW_COMMANDS.WORK]: "full",
  [WORKFLOW_COMMANDS.REVIEW_WORK]: "review",
  [WORKFLOW_COMMANDS.CONSOLIDATE]: "write_unipi",
  [WORKFLOW_COMMANDS.WORKTREE_CREATE]: "full",
  [WORKFLOW_COMMANDS.WORKTREE_LIST]: "read_only",
  [WORKFLOW_COMMANDS.WORKTREE_MERGE]: "full",
  [WORKFLOW_COMMANDS.CONSULTANT]: "read_only",
  [WORKFLOW_COMMANDS.QUICK_WORK]: "full",
  [WORKFLOW_COMMANDS.GATHER_CONTEXT]: "read_only",
  [WORKFLOW_COMMANDS.DOCUMENT]: "write_unipi",
  [WORKFLOW_COMMANDS.SCAN_ISSUES]: "read_only",
  [WORKFLOW_COMMANDS.AUTO]: "full",
  [WORKFLOW_COMMANDS.DEBUG]: "read_only",
  [WORKFLOW_COMMANDS.FIX]: "full",
  [WORKFLOW_COMMANDS.QUICK_FIX]: "full",
  [WORKFLOW_COMMANDS.RESEARCH]: "read_only",
  [WORKFLOW_COMMANDS.CHORE_CREATE]: "write_unipi",
  [WORKFLOW_COMMANDS.CHORE_EXECUTE]: "full",
};

/**
 * Get sandbox level for a command.
 */
export function getSandboxLevel(commandName: string): SandboxLevel {
  return COMMAND_SANDBOX[commandName] ?? "full";
}

/**
 * Get fallback tools for a sandbox level.
 *
 * Prefer filterToolsForLevel(level, activeTools) when applying a sandbox so
 * extension tools are preserved unless explicitly blocked.
 */
export function getToolsForLevel(level: SandboxLevel): readonly string[] {
  return FALLBACK_TOOLS[level];
}

/**
 * Get tool names explicitly blocked by a sandbox level.
 */
export function getBlockedToolsForLevel(level: SandboxLevel): readonly string[] {
  return BLOCKED_TOOLS[level];
}

/**
 * Filter the current active tool set for a sandbox level.
 *
 * This preserves safe extension tools (memory_search, memory_store, ask_user,
 * web tools, notifications, etc.) instead of replacing the tool list with a
 * small built-in allow-list. Only tools that violate the level are removed.
 */
export function filterToolsForLevel(
  level: SandboxLevel,
  activeTools: readonly string[],
): readonly string[] {
  const blocked = new Set(BLOCKED_TOOLS[level]);
  return activeTools.filter((tool) => !blocked.has(tool));
}

/**
 * Get allowed tools for a command.
 */
export function getToolsForCommand(
  commandName: string,
  activeTools?: readonly string[],
): readonly string[] {
  const level = getSandboxLevel(commandName);
  return activeTools ? filterToolsForLevel(level, activeTools) : getToolsForLevel(level);
}

/**
 * Check if a tool is allowed at a sandbox level.
 */
export function isToolAllowed(level: SandboxLevel, toolName: string): boolean {
  return !BLOCKED_TOOLS[level].includes(toolName);
}

/**
 * Check if a command has write access.
 */
export function hasWriteAccess(commandName: string): boolean {
  const level = getSandboxLevel(commandName);
  return !BLOCKED_TOOLS[level].includes("write");
}

/**
 * Check if a command has bash access.
 */
export function hasBashAccess(commandName: string): boolean {
  const level = getSandboxLevel(commandName);
  return !BLOCKED_TOOLS[level].includes("bash");
}
