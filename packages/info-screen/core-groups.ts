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
  // Try to find pi's package.json in various locations
  const possiblePaths = [
    // Global npm install
    join(homedir(), ".local", "share", "mise", "installs", "node", "24.14.1", "lib", "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
    // Alternative locations
    join(homedir(), ".local", "share", "mise", "installs", "node", "lib", "node_modules", "@mariozechner", "pi-coding-agent", "package.json"),
  ];

  for (const pkgPath of possiblePaths) {
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg?.version ?? "unknown";
      }
    } catch {
      // Continue to next path
    }
  }

  // Fallback: try to run pi --version
  try {
    const { execSync } = require("node:child_process");
    const version = execSync("pi --version 2>/dev/null", { encoding: "utf-8" }).trim();
    // Extract version number from output like "pi v0.42.4"
    const match = version.match(/v([\d.]+)/);
    if (match) return match[1];
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
          const npmPkg = source.slice(4);
          // Handle scoped packages like @scope/name
          if (npmPkg.startsWith("@")) {
            // @scope/name -> name
            const parts = npmPkg.split("/");
            name = parts.length > 1 ? parts[1] : npmPkg;
          } else {
            name = npmPkg.split("@")[0];
          }
        } else if (source.startsWith("git:")) {
          name = source.split("/").pop()?.replace(/\.git$/, "") ?? source;
        }

        // Skip empty names
        if (!name || name.trim() === "") continue;
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
 * Load time tracking.
 */
const loadTimes: Array<{ name: string; type: string; ms: number }> = [];
let totalLoadTimeMs = 0;
let loadTrackingStarted = false;
let loadTrackingStartMs = 0;
const moduleStartTimes = new Map<string, number>();

/** Start load time tracking */
export function startLoadTracking(): void {
  if (!loadTrackingStarted) {
    loadTrackingStartMs = Date.now();
    loadTrackingStarted = true;
  }
}

/** Record when a module starts loading */
export function recordModuleStart(name: string): void {
  moduleStartTimes.set(name, Date.now());
}

/** Record a load time */
export function recordLoadTime(name: string, type: string, ms?: number): void {
  // If no ms provided, calculate from start time
  if (ms === undefined || ms === 0) {
    const startTime = moduleStartTimes.get(name);
    if (startTime) {
      ms = Date.now() - startTime;
    } else {
      ms = 0;
    }
  }
  // Avoid duplicates
  const existing = loadTimes.find(t => t.name === name && t.type === type);
  if (!existing) {
    loadTimes.push({ name, type, ms });
    totalLoadTimeMs += ms;
  }
}

/** Finish load tracking */
export function finishLoadTracking(): void {
  if (loadTrackingStarted) {
    totalLoadTimeMs = Date.now() - loadTrackingStartMs;
  }
}

/** Get load times */
export function getLoadTimes(): Array<{ name: string; type: string; ms: number }> {
  return [...loadTimes];
}

/** Get total load time */
export function getTotalLoadTime(): number {
  return totalLoadTimeMs > 0 ? totalLoadTimeMs : (loadTrackingStarted ? Date.now() - loadTrackingStartMs : 0);
}

/**
 * Additional skill directories registered by extensions.
 */
const extraSkillDirs: string[] = [];

/**
 * Register an additional skill directory (from extensions).
 */
export function registerSkillDir(dir: string): void {
  if (!extraSkillDirs.includes(dir)) {
    extraSkillDirs.push(dir);
  }
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
    // Add extra dirs from extensions
    ...extraSkillDirs,
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
          // Determine source based on path
          let source = "extension";
          if (dir.includes(join(homeDir, ".pi"))) {
            source = "global";
          } else if (dir === join(cwd, ".pi", "skills")) {
            source = "project";
          }
          skills.push({ name, source });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  return skills;
}

/**
 * Track announced modules.
 */
const announcedModules: Array<{ name: string; version: string }> = [];

/**
 * Track registered tools.
 */
const registeredTools: Array<{ name: string; source: string }> = [];

/**
 * Reference to pi API for getting tools.
 */
let piApi: any = null;

/**
 * Set the pi API reference.
 */
export function setPiApi(api: any): void {
  piApi = api;
}

/**
 * Add a module to the announced list.
 */
export function trackModule(name: string, version: string): void {
  if (!announcedModules.find((m) => m.name === name)) {
    announcedModules.push({ name, version });
  }
}

/**
 * Get list of announced modules.
 */
export function getAnnouncedModules(): Array<{ name: string; version: string }> {
  return [...announcedModules];
}

/**
 * Track a registered tool.
 */
export function trackTool(name: string, source: string): void {
  if (!registeredTools.find((t) => t.name === name)) {
    registeredTools.push({ name, source });
  }
}

/**
 * Get list of registered tools.
 */
export function getRegisteredTools(): Array<{ name: string; source: string }> {
  return [...registeredTools];
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
        { id: "loadTime", label: "Total Load Time", show: true },
      ],
    },
    dataProvider: async () => {
      const cwd = process.cwd();
      const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
      const shortCwd = cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd;

      // Get modules from announced events AND registered groups
      const announced = getAnnouncedModules();
      const registeredGroups = infoRegistry.getAllGroups();
      
      // Combine: announced modules + groups that aren't from announced modules
      const moduleNames = new Set<string>();
      for (const m of announced) {
        moduleNames.add(m.name.replace(/^@[^/]+\//, ""));
      }
      // Add non-core groups as modules (they come from extensions)
      const coreGroupIds = new Set(["overview", "usage", "tools", "extensions", "skills"]);
      for (const g of registeredGroups) {
        if (!coreGroupIds.has(g.id)) {
          moduleNames.add(g.id);
        }
      }
      
      const totalLoadTime = getTotalLoadTime();
      const moduleList = Array.from(moduleNames);

      return {
        version: { value: getPiVersion(), detail: "pi" },
        cwd: { value: shortCwd },
        modules: {
          value: String(moduleList.length),
          detail: moduleList.slice(0, 4).join(", ") + (moduleList.length > 4 ? ` +${moduleList.length - 4} more` : ""),
        },
        uptime: { value: formatUptime(process.uptime()) },
        loadTime: { value: `${totalLoadTime}ms` },
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
        { id: "topModelToday", label: "Top Model Today", show: true },
        { id: "topModelWeek", label: "Top Model Week", show: true },
        { id: "topModelMonth", label: "Top Model Month", show: true },
        { id: "sessions", label: "Total Sessions", show: true },
      ],
    },
    dataProvider: async () => {
      const stats = parseUsageStats();

      // Find top model for each period
      const findTopModel = (modelStats: Record<string, { tokens: number; cost: number; sessions: number }> | undefined) => {
        if (!modelStats) return { name: "none", cost: 0 };
        let topName = "none";
        let topCost = 0;
        for (const [model, data] of Object.entries(modelStats)) {
          if (data.cost > topCost) {
            topCost = data.cost;
            topName = model;
          }
        }
        // Strip "Claude " prefix for brevity
        if (topName.startsWith("Claude ")) {
          topName = topName.slice(7);
        }
        return { name: topName, cost: topCost };
      };

      const topToday = findTopModel(stats.byModelToday);
      const topWeek = findTopModel(stats.byModelWeek);
      const topMonth = findTopModel(stats.byModelMonth);

      return {
        tokensToday: { value: formatTokens(stats.tokens.today) },
        tokensWeek: { value: formatTokens(stats.tokens.week) },
        tokensMonth: { value: formatTokens(stats.tokens.month) },
        costToday: { value: formatCost(stats.cost.today) },
        costAllTime: { value: formatCost(stats.cost.allTime) },
        topModelToday: { value: topToday.name, detail: formatCost(topToday.cost) },
        topModelWeek: { value: topWeek.name, detail: formatCost(topWeek.cost) },
        topModelMonth: { value: topMonth.name, detail: formatCost(topMonth.cost) },
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
        { id: "list", label: "Tools", show: true },
      ],
    },
    dataProvider: async () => {
      // Use pi.getAllTools() to get actual tools with source info
      let tools: Array<{ name: string; source?: string; sourceInfo?: any }> = [];
      
      if (piApi && typeof piApi.getAllTools === "function") {
        try {
          tools = piApi.getAllTools();
        } catch {
          // Fallback to tracked tools
          tools = getRegisteredTools();
        }
      } else {
        tools = getRegisteredTools();
      }

      // Categorize by source
      const builtin = tools.filter((t) => {
        const source = t.sourceInfo?.source || t.source;
        return source === "builtin";
      });
      const extension = tools.filter((t) => {
        const source = t.sourceInfo?.source || t.source;
        return source !== "builtin" && source !== "sdk";
      });
      const sdk = tools.filter((t) => {
        const source = t.sourceInfo?.source || t.source;
        return source === "sdk";
      });

      // Build tool list as comma-separated values with wrapping
      const toolNames = tools.map((t) => `${t.name}`);
      // Split into chunks of ~60 chars for wrapping
      const chunks: string[] = [];
      let current = "";
      for (const name of toolNames) {
        if (current && (current.length + name.length + 2) > 60) {
          chunks.push(current);
          current = name;
        } else {
          current = current ? `${current}, ${name}` : name;
        }
      }
      if (current) chunks.push(current);

      return {
        total: { value: String(tools.length) },
        builtin: { value: String(builtin.length) },
        registered: { value: String(extension.length + sdk.length) },
        list: {
          value: chunks.length > 0 ? chunks[0] : "none",
          detail: chunks.length > 1 ? chunks.slice(1).join("\n") : undefined,
        },
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

      // Build multi-line list - show all
      const listLines: string[] = [];
      for (const ext of extensions) {
        listLines.push(`${ext.name} (${ext.source})`);
      }

      return {
        count: { value: String(extensions.length), detail: breakdown || "none" },
        list: {
          value: listLines.length > 0 ? listLines[0] : "none",
          detail: listLines.length > 1 ? listLines.slice(1).join("\n") : undefined,
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
        { id: "list", label: "Skills", show: true },
      ],
    },
    dataProvider: async () => {
      const skills = discoverSkills();
      const global = skills.filter((s) => s.source === "global");
      const project = skills.filter((s) => s.source === "project");

      // Build skill list as comma-separated values with wrapping
      const skillNames = skills.map((s) => `${s.name} (${s.source})`);
      // Split into chunks of ~60 chars for wrapping
      const chunks: string[] = [];
      let current = "";
      for (const name of skillNames) {
        if (current && (current.length + name.length + 2) > 60) {
          chunks.push(current);
          current = name;
        } else {
          current = current ? `${current}, ${name}` : name;
        }
      }
      if (current) chunks.push(current);

      return {
        count: { value: String(skills.length) },
        global: { value: String(global.length) },
        project: { value: String(project.length) },
        list: {
          value: chunks.length > 0 ? chunks[0] : "none",
          detail: chunks.length > 1 ? chunks.slice(1).join("\n") : undefined,
        },
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
