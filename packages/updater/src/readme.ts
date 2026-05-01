/**
 * @pi-unipi/updater — Readme discovery
 *
 * Discovers package README.md paths from the unipi monorepo.
 * Root README from the unipi package root, package READMEs from
 * node_modules/@pi-unipi/{name}/README.md.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { findPackageRoot } from "@pi-unipi/core";
import { MODULES } from "@pi-unipi/core";
import type { ReadmeEntry } from "../types.js";

/** Short name → full package name mapping from MODULES constant */
const PACKAGE_MAP: Record<string, string> = {
  core: MODULES.CORE,
  workflow: MODULES.WORKFLOW,
  ralph: MODULES.RALPH,
  memory: MODULES.MEMORY,
  "info-screen": MODULES.INFO_SCREEN,
  registry: MODULES.REGISTRY,
  mcp: MODULES.MCP,
  task: MODULES.TASK,
  "web-api": MODULES.WEB_API,
  impeccable: MODULES.IMPECCABLE,
  settings: MODULES.SETTINGS,
  utility: MODULES.UTILITY,
  "ask-user": MODULES.ASK_USER,
  compactor: MODULES.COMPACTOR,
  notify: MODULES.NOTIFY,
  btw: MODULES.BTW,
  milestone: MODULES.MILESTONE,
  kanboard: MODULES.KANBOARD,
  footer: MODULES.FOOTER,
  updater: MODULES.UPDATER,
};

/** Resolve the unipi package root directory */
function resolveUnipiRoot(): string {
  // Walk up from this file to find @pi-unipi/unipi by name
  const dir = new URL(".", import.meta.url).pathname;
  const root = findPackageRoot(dir, "@pi-unipi/unipi");
  return root ?? join(dir, ".."); // fallback to parent
}

/** Get version from a package.json at the given directory */
function getPackageVersion(dir: string): string {
  try {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      return pkg.version ?? "0.0.0";
    }
  } catch (_err) {
    // Ignore parse errors
  }
  return "0.0.0";
}

/**
 * Discover all available README.md files.
 * Returns entries for the root README and all package READMEs that exist.
 */
export function discoverReadmes(): ReadmeEntry[] {
  const root = resolveUnipiRoot();
  const entries: ReadmeEntry[] = [];

  // Root README
  const rootReadme = join(root, "README.md");
  if (existsSync(rootReadme)) {
    entries.push({
      name: "unipi",
      packageName: "@pi-unipi/unipi",
      version: getPackageVersion(root),
      path: rootReadme,
    });
  }

  // Package READMEs — check both workspace layout and node_modules layout
  for (const [shortName, fullName] of Object.entries(PACKAGE_MAP)) {
    // Workspace layout: packages/{shortName}/README.md
    const workspacePath = join(root, "packages", shortName, "README.md");
    // node_modules layout: node_modules/{fullName}/README.md
    const nodeModulesPath = join(root, "node_modules", fullName, "README.md");

    let readmePath: string | null = null;
    let versionDir: string | null = null;

    if (existsSync(workspacePath)) {
      readmePath = workspacePath;
      versionDir = join(root, "packages", shortName);
    } else if (existsSync(nodeModulesPath)) {
      readmePath = nodeModulesPath;
      versionDir = join(root, "node_modules", fullName);
    }

    if (readmePath && versionDir) {
      entries.push({
        name: shortName,
        packageName: fullName,
        version: getPackageVersion(versionDir),
        path: readmePath,
      });
    }
  }

  return entries;
}

/**
 * Resolve the README path for a specific package.
 * If packageName is undefined or empty, returns the root README.
 * Returns null if the README doesn't exist.
 */
export function resolveReadmePath(packageName?: string): string | null {
  const root = resolveUnipiRoot();

  if (!packageName || packageName === "unipi") {
    const rootReadme = join(root, "README.md");
    return existsSync(rootReadme) ? rootReadme : null;
  }

  // Look up the short name in the package map
  const fullName = PACKAGE_MAP[packageName];
  if (!fullName) return null;

  // Check workspace layout first
  const workspacePath = join(root, "packages", packageName, "README.md");
  if (existsSync(workspacePath)) return workspacePath;

  // Then node_modules
  const nodeModulesPath = join(root, "node_modules", fullName, "README.md");
  if (existsSync(nodeModulesPath)) return nodeModulesPath;

  return null;
}
