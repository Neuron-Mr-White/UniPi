/**
 * Security policy — pattern parsing, glob-to-regex
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface SecurityPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

export function parseBashPattern(pattern: string): string | null {
  const match = pattern.match(/^Bash\((.+)\)$/);
  return match ? match[1] : null;
}

export function parseToolPattern(pattern: string): { tool: string; glob: string } | null {
  const match = pattern.match(/^(\w+)\((.+)\)$/);
  return match ? { tool: match[1], glob: match[2] } : null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\/\-]/g, "\\$&");
}

function convertGlobPart(glob: string): string {
  return glob
    .replace(/[.+?^${}()|[\]\\/\-]/g, "\\$&")
    .replace(/\*/g, ".*");
}

export function globToRegex(glob: string, caseInsensitive: boolean = false): RegExp {
  let regexStr: string;
  const colonIdx = glob.indexOf(":");
  if (colonIdx !== -1) {
    const command = glob.slice(0, colonIdx);
    const argsGlob = glob.slice(colonIdx + 1);
    const escapedCmd = escapeRegex(command);
    const argsRegex = convertGlobPart(argsGlob);
    regexStr = `^${escapedCmd}(\\s${argsRegex})?$`;
  } else {
    regexStr = `^${convertGlobPart(glob)}$`;
  }
  return new RegExp(regexStr, caseInsensitive ? "i" : "");
}

export function fileGlobToRegex(glob: string, caseInsensitive: boolean = false): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < glob.length) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      if (i + 2 < glob.length && glob[i + 2] === "/") {
        regexStr += "(.*/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (glob[i] === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (glob[i] === "?") {
      regexStr += "[^/]";
      i++;
    } else {
      regexStr += escapeRegex(glob[i]);
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`, caseInsensitive ? "i" : "");
}

/**
 * Create a minimal deny-only policy by reading .pi/settings.json in cwd.
 * Returns a SecurityPolicy with deny patterns populated (fail-open: returns empty on error).
 */
export function readsOrCreatesPolicy(cwd: string): SecurityPolicy {
  const settingsPath = join(cwd, ".pi", "settings.json");
  if (!existsSync(settingsPath)) return { allow: [], deny: [], ask: [] };
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const permissions = settings.permissions ?? settings.security ?? {};
    return {
      deny: [...(permissions.deny ?? [])],
      ask: [...(permissions.ask ?? [])],
      allow: [...(permissions.allow ?? [])],
    };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}
