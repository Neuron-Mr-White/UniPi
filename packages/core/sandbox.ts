/**
 * @unipi/core — Sandbox module
 *
 * Defines tool access levels for workflow commands.
 * Used with pi.setActiveTools() to enforce restrictions.
 */

import { WORKFLOW_COMMANDS } from "./constants.js";

/** Sandbox levels */
export type SandboxLevel = "read_only" | "brainstorm" | "write_unipi" | "review" | "full";

/** Tool sets per sandbox level */
const SANDBOX_TOOLS: Record<SandboxLevel, readonly string[]> = {
  /** Only read-only tools — no bash, no write, no edit */
  read_only: ["read", "grep", "find", "ls"],
  /** Read + constrained write + bash (setup only) — only to .unipi/docs/specs/ */
  brainstorm: ["read", "grep", "find", "ls", "write", "bash"],
  /** Read + write/edit + file discovery — no bash */
  write_unipi: ["read", "write", "edit", "grep", "find", "ls"],
  /** Read + write + bash for git operations — no code editing outside .unipi */
  review: ["read", "write", "edit", "grep", "find", "ls", "bash"],
  /** All tools */
  full: ["read", "write", "edit", "bash"],
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
};

/**
 * Get sandbox level for a command.
 */
export function getSandboxLevel(commandName: string): SandboxLevel {
  return COMMAND_SANDBOX[commandName] ?? "full";
}

/**
 * Get allowed tools for a sandbox level.
 */
export function getToolsForLevel(level: SandboxLevel): readonly string[] {
  return SANDBOX_TOOLS[level];
}

/**
 * Get allowed tools for a command.
 */
export function getToolsForCommand(commandName: string): readonly string[] {
  const level = getSandboxLevel(commandName);
  return getToolsForLevel(level);
}

/**
 * Check if a tool is allowed at a sandbox level.
 */
export function isToolAllowed(level: SandboxLevel, toolName: string): boolean {
  return SANDBOX_TOOLS[level].includes(toolName);
}

/**
 * Check if a command has write access.
 */
export function hasWriteAccess(commandName: string): boolean {
  const level = getSandboxLevel(commandName);
  return level === "write_unipi" || level === "full";
}

/**
 * Check if a command has bash access.
 */
export function hasBashAccess(commandName: string): boolean {
  const level = getSandboxLevel(commandName);
  return level === "full" || level === "brainstorm";
}
