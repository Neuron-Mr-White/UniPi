/**
 * @pi-unipi/utility — Environment Info Tool
 *
 * Show environment information for debugging.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { EnvironmentInfo } from "../types.js";

/** Collect environment information */
export function getEnvironmentInfo(): EnvironmentInfo {
  const unipiModules: string[] = [];
  const configPaths: string[] = [];
  const extensionPaths: string[] = [];

  // Try to discover unipi modules from node_modules
  try {
    const nodeModules = resolve(process.cwd(), "node_modules");
    if (existsSync(nodeModules)) {
      const scopePath = join(nodeModules, "@pi-unipi");
      if (existsSync(scopePath)) {
        for (const entry of readdirSync(scopePath)) {
          if (entry.startsWith(".")) continue;
          const pkgPath = join(scopePath, entry, "package.json");
          if (existsSync(pkgPath)) {
            unipiModules.push(`@pi-unipi/${entry}`);
          }
        }
      }
    }
  } catch {
    // Best effort
  }

  // Config paths
  const globalConfig = join(homedir(), ".unipi", "config");
  const projectConfig = resolve(process.cwd(), ".unipi", "config");

  if (existsSync(globalConfig)) {
    configPaths.push(globalConfig);
  }
  if (existsSync(projectConfig)) {
    configPaths.push(projectConfig);
  }

  // Extension paths (pi-specific)
  try {
    const piDir = join(homedir(), ".pi");
    if (existsSync(piDir)) {
      extensionPaths.push(piDir);
    }
  } catch {
    // Best effort
  }

  return {
    nodeVersion: process.version,
    piVersion: getPiVersion(),
    os: `${process.platform} ${process.arch}`,
    platform: process.platform,
    unipiModules,
    configPaths,
    extensionPaths,
  };
}

/** Try to determine Pi version */
function getPiVersion(): string {
  try {
    // Try to read from pi's package
    const piPkg = resolve(
      process.cwd(),
      "node_modules",
      "@mariozechner",
      "pi-coding-agent",
      "package.json",
    );
    if (existsSync(piPkg)) {
      const { readFileSync } = require("node:fs");
      const pkg = JSON.parse(readFileSync(piPkg, "utf-8"));
      return pkg.version || "unknown";
    }
  } catch {
    // Best effort
  }
  return "unknown";
}

/** Format environment info as markdown */
export function formatEnvironmentInfo(info: EnvironmentInfo): string {
  const lines = [
    "## 🖥️ Environment",
    "",
    `| Key | Value |`,
    `|-----|-------|`,
    `| Node.js | ${info.nodeVersion} |`,
    `| Pi | ${info.piVersion} |`,
    `| OS | ${info.os} |`,
    `| Platform | ${info.platform} |`,
    "",
    "### Unipi Modules",
    "",
  ];

  if (info.unipiModules.length === 0) {
    lines.push("*No @pi-unipi modules detected in node_modules.*");
  } else {
    for (const mod of info.unipiModules) {
      lines.push(`- ${mod}`);
    }
  }

  lines.push("", "### Config Paths", "");
  if (info.configPaths.length === 0) {
    lines.push("*No config paths found.*");
  } else {
    for (const path of info.configPaths) {
      lines.push(`- \`${path}\``);
    }
  }

  lines.push("", "### Extension Paths", "");
  if (info.extensionPaths.length === 0) {
    lines.push("*No extension paths found.*");
  } else {
    for (const path of info.extensionPaths) {
      lines.push(`- \`${path}\``);
    }
  }

  return lines.join("\n");
}
