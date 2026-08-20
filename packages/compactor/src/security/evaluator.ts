/**
 * Security evaluator — command + file path evaluation
 *
 * Supports loading permission patterns from .pi/settings.json
 */

import { realpathSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { PermissionDecision, SecurityPolicy } from "./policy.js";
import { parseBashPattern, parseToolPattern, globToRegex, fileGlobToRegex } from "./policy.js";

/**
 * Load permission patterns from .pi/settings.json in the given directory.
 * Returns a SecurityPolicy merged with the provided policy.
 */
export function evaluateCommand(
  command: string,
  policy: SecurityPolicy,
): PermissionDecision {
  // Deny takes highest precedence
  for (const pattern of policy.deny) {
    const bashGlob = parseBashPattern(pattern);
    if (bashGlob && globToRegex(bashGlob, true).test(command)) return "deny";
    const toolPattern = parseToolPattern(pattern);
    if (toolPattern && toolPattern.tool === "Bash" && globToRegex(toolPattern.glob, true).test(command)) {
      return "deny";
    }
  }

  // Ask patterns
  for (const pattern of policy.ask) {
    const bashGlob = parseBashPattern(pattern);
    if (bashGlob && globToRegex(bashGlob, true).test(command)) return "ask";
    const toolPattern = parseToolPattern(pattern);
    if (toolPattern && toolPattern.tool === "Bash" && globToRegex(toolPattern.glob, true).test(command)) {
      return "ask";
    }
  }

  // Allow patterns
  for (const pattern of policy.allow) {
    const bashGlob = parseBashPattern(pattern);
    if (bashGlob && globToRegex(bashGlob, true).test(command)) return "allow";
    const toolPattern = parseToolPattern(pattern);
    if (toolPattern && toolPattern.tool === "Bash" && globToRegex(toolPattern.glob, true).test(command)) {
      return "allow";
    }
  }

  return "allow";
}

export function evaluateFilePath(
  filePath: string,
  policy: SecurityPolicy,
  cwd: string = process.cwd(),
): PermissionDecision {
  const resolved = resolve(cwd, filePath);

  // Prevent symlink escape
  try {
    const real = realpathSync(resolved);
    const home = homedir();
    if (!real.startsWith(cwd) && !real.startsWith(home)) {
      return "deny";
    }
  } catch {
    // File doesn't exist yet — check path pattern
  }

  for (const pattern of policy.deny) {
    const toolPattern = parseToolPattern(pattern);
    if (!toolPattern) continue;
    if (["Read", "Edit", "Write", "read", "edit", "write"].includes(toolPattern.tool)) {
      if (fileGlobToRegex(toolPattern.glob, true).test(resolved)) return "deny";
    }
  }

  for (const pattern of policy.ask) {
    const toolPattern = parseToolPattern(pattern);
    if (!toolPattern) continue;
    if (["Read", "Edit", "Write", "read", "edit", "write"].includes(toolPattern.tool)) {
      if (fileGlobToRegex(toolPattern.glob, true).test(resolved)) return "ask";
    }
  }

  return "allow";
}
