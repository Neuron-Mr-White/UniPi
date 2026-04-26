/**
 * @pi-unipi/info-screen — Core group registrations
 *
 * Registers the 5 core groups: Overview, Usage, Tools, Extensions, Skills.
 * These are always available (subject to config visibility).
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { infoRegistry } from "./registry.js";
import { parseUsageStats, formatTokens, formatCost } from "./usage-parser.js";
import type { InfoGroup } from "./types.js";

/**
 * Get package version from package.json.
 */
function getPackageVersion(packageDir: string): string {
  try {
    const pkgPath = join(packageDir, "package.json");
    if (!existsSync(pkgPath)) return "0.0.0";
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg?.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Get pi version from its package.json.
 */
function getPiVersion(): string {
  try {
    const piPath = join(homedir(), ".local", "share", "mise", "installs", "node");
    // Fallback: try to find pi's package.json
    const homePi = join(homedir(), ".pi", "agent", "package.json");
    if (existsSync(homePi)) {
      const pkg = JSON.parse(readFileSync(homePi, "utf-8"));
      return pkg?.version ?? "unknown";
    }
  } catch {
    // Ignore
  }
  return "unknown";
}

/**
 * Discover loaded extensions by scanning filesystem.
 */
function discoverExtensions(): Array<{ name: string; source: string; version: string }> {
  const extensions: Array<{ name: string; source: string; version: string }> = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const cwd = process.cwd();

  // Check settings.json for package extensions
  const settingsPaths = [
    join(homeDir, ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];

  const counted = new Set<string>();

  for (const settingsPath of settingsPaths) {
    if (!existsSync(settingsPath)) continue;

    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (typeof settings !== "object" || settings === null) continue;

      const packages = settings.packages;
      if (!Array.isArray(packages)) continue;

      for (const pkg of packages) {
        let source: string | undefined;
        let extensionsFilter: string[] | undefined;

        if (typeof pkg === "string") {
          source = pkg;
        } else if (typeof pkg === "object" && pkg !== null) {
          source = pkg.source;
          extensionsFilter = pkg.extensions;
        }

        if (!source) continue;

        // Extract package name from source
        let name = source;
        if (source.startsWith("npm:")) {
          name = source.slice(4).split("@")[0];
        } else if (source.startsWith("git:")) {
          name = source.split("/").pop() ?? source;
        }

        if (counted.has(name)) continue;
        counted.add(name);

        extensions.push({
          name,
          source: source.startsWith("npm:") ? "npm" : source.startsWith("git:") ? "git" : "local",
          version: "latest",
        });
      }
    } catch {
      // Skip malformed settings
    }
  }

  // Check extension directories
  const extensionDirs = [
    join(homeDir, ".pi", "agent", "extensions"),
    join(cwd, ".pi", "extensions"),
  ];

  for (const dir of extensionDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const name = entry.name;
        if (counted.has(name)) continue;

        if (entry.isFile() && name.endsWith(".ts")) {
          counted.add(name.replace(".ts", ""));
          extensions.push({
            name: name.replace(".ts", ""),
            source: "local",
            version: "local",
          });
        } else if (entry.isDirectory()) {
          counted.add(name);
          extensions.push({
            name,
            source: "local",
            version: "local",
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return extensions;
}

/**
 * Discover loaded skills by scanning filesystem.
 */
function discoverSkills(): Array<{ name: string; source: string }> {
  const skills: Array<{ name: string; source: string }> = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const cwd = process.cwd();

  // Skill directories to scan
  const skillDirs = [
    join(homeDir, ".pi", "agent", "skills"),
    join(cwd, ".pi", "skills"),
  ];

  const counted = new Set<string>();

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const name = entry.name;
        if (counted.has(name)) continue;

        // Check if it has a SKILL.md
        const skillPath = join(dir, name, "SKILL.md");
        if (existsSync(skillPath)) {
          counted.add(name);
          skills.push({
            name,
            source: dir.includes(homeDir) ? "global" : "project",
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return skills;
}

/**
 * Register all core groups.
 */
export function registerCoreGroups(): void {
  // 1. Overview group
  infoRegistry.registerGroup({
    id: "overview",
    name: "Overview",
    icon: "📊",
    priority: 10,
    config: {
      showByDefault: true,
      stats: [
        { id: "version", label: "Pi Version", show: true },
        { id: "cwd", label: "Working Directory", show: true },
        { id: "modules", label: "Active Modules", show: true },
        { id: "uptime", label: "Session Uptime", show: true },
      ],
    },
    dataProvider: async () => {
      const cwd = process.cwd();
      const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
      const shortCwd = cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd;

      return {
        version: { value: "0.1.0", detail: "unipi" },
        cwd: { value: shortCwd },
        modules: { value: "loading...", detail: "updated on boot" },
        uptime: { value: formatUptime(process.uptime()) },
      };
    },
  });

  // 2. Usage group
  infoRegistry.registerGroup({
    id: "usage",
    name: "Usage",
    icon: "💰",
    priority: 20,
    config: {
      showByDefault: true,
      stats: [
        { id: "tokensToday", label: "Tokens Today", show: true },
        { id: "tokensWeek", label: "Tokens This Week", show: true },
        { id: "tokensMonth", label: "Tokens This Month", show: true },
        { id: "costToday", label: "Cost Today", show: true },
        { id: "costAllTime", label: "Cost All Time", show: true },
        { id: "topModel", label: "Top Model", show: true },
        { id: "sessions", label: "Total Sessions", show: true },
      ],
    },
    dataProvider: async () => {
      const stats = parseUsageStats();

      // Find top model by cost
      let topModel = "none";
      let topCost = 0;
      for (const [model, data] of Object.entries(stats.byModel)) {
        if (data.cost > topCost) {
          topCost = data.cost;
          topModel = model;
        }
      }

      // Strip "Claude " prefix for brevity
      if (topModel.startsWith("Claude ")) {
        topModel = topModel.slice(7);
      }

      return {
        tokensToday: { value: formatTokens(stats.tokens.today) },
        tokensWeek: { value: formatTokens(stats.tokens.week) },
        tokensMonth: { value: formatTokens(stats.tokens.month) },
        costToday: { value: formatCost(stats.cost.today) },
        costAllTime: { value: formatCost(stats.cost.allTime) },
        topModel: { value: topModel, detail: formatCost(topCost) },
        sessions: { value: String(stats.sessionCount) },
      };
    },
  });

  // 3. Tools group
  infoRegistry.registerGroup({
    id: "tools",
    name: "Tools",
    icon: "🔧",
    priority: 30,
    config: {
      showByDefault: true,
      stats: [
        { id: "total", label: "Total Tools", show: true },
        { id: "builtin", label: "Built-in", show: true },
        { id: "registered", label: "Registered", show: true },
      ],
    },
    dataProvider: async () => {
      // Tool count will be injected by the extension
      return {
        total: { value: "loading..." },
        builtin: { value: "loading..." },
        registered: { value: "loading..." },
      };
    },
  });

  // 4. Extensions group
  infoRegistry.registerGroup({
    id: "extensions",
    name: "Extensions",
    icon: "📦",
    priority: 40,
    config: {
      showByDefault: true,
      stats: [
        { id: "count", label: "Total Extensions", show: true },
        { id: "list", label: "Extensions", show: true },
      ],
    },
    dataProvider: async () => {
      const extensions = discoverExtensions();
      const bySource: Record<string, number> = {};
      for (const ext of extensions) {
        bySource[ext.source] = (bySource[ext.source] ?? 0) + 1;
      }

      const breakdown = Object.entries(bySource)
        .map(([src, count]) => `${count} ${src}`)
        .join(", ");

      return {
        count: { value: String(extensions.length), detail: breakdown || "none" },
        list: {
          value: extensions.length > 0
            ? extensions.slice(0, 5).map((e) => e.name).join(", ")
            : "none",
          detail: extensions.length > 5 ? `+${extensions.length - 5} more` : undefined,
        },
      };
    },
  });

  // 5. Skills group
  infoRegistry.registerGroup({
    id: "skills",
    name: "Skills",
    icon: "🎯",
    priority: 50,
    config: {
      showByDefault: true,
      stats: [
        { id: "count", label: "Total Skills", show: true },
        { id: "global", label: "Global Skills", show: true },
        { id: "project", label: "Project Skills", show: true },
      ],
    },
    dataProvider: async () => {
      const skills = discoverSkills();
      const global = skills.filter((s) => s.source === "global").length;
      const project = skills.filter((s) => s.source === "project").length;

      return {
        count: { value: String(skills.length) },
        global: { value: String(global) },
        project: { value: String(project) },
      };
    },
  });
}

/**
 * Format uptime for display.
 */
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}
