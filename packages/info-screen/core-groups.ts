/**
 * @pi-unipi/info-screen — core pages: Session, Usage, Tools, Skills, Modules.
 *
 * Data comes from pi itself (live context, getAllTools, getCommands, module
 * announcements) rather than filesystem scans, so it is cheap and it is what
 * is actually loaded. Module packages register their own pages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getInstalledPackageVersion, listSettingsDefinitions } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import { parseUsageStatsAsync } from "./usage-parser.js";
import { collectSession, renderSession, sessionData, type SessionCtxLike } from "./pages/session.js";
import { renderUsage, usageData, type UsageRaw } from "./pages/usage.js";
import { setCompactorHistorySource } from "./pages/modules.js";
import { inventoryData, renderInventory, renderModules, type ModulesRaw, type Named } from "./pages/inventory.js";
import type { Scope } from "./palette.js";

// ─── load tracking ─────────────────────────────────────────────────────────

const loadTimes = new Map<string, number>();
let loadStart = 0;
let totalLoadTimeMs = 0;

export function startLoadTracking(): void {
  if (!loadStart) loadStart = Date.now();
}

export function recordLoadTime(name: string, _type: string, ms?: number): void {
  if (!loadTimes.has(name)) loadTimes.set(name, ms ?? 0);
}

export function finishLoadTracking(): void {
  if (loadStart && !totalLoadTimeMs) totalLoadTimeMs = Date.now() - loadStart;
}

export function getTotalLoadTime(): number {
  return totalLoadTimeMs || (loadStart ? Date.now() - loadStart : 0);
}

/** Startup cost measured by packages/unipi around each module's register call. */
function moduleLoadMs(name: string): number {
  const g = (globalThis as { __unipi_load_times?: Record<string, number> }).__unipi_load_times;
  return g?.[name] ?? loadTimes.get(name) ?? 0;
}

// ─── module / tool tracking (fed by MODULE_READY) ─────────────────────────

const announcedModules: Array<{ name: string; version: string }> = [];
const registeredTools: Array<{ name: string; source: string }> = [];

export function trackModule(name: string, version: string): void {
  if (!announcedModules.find((m) => m.name === name)) announcedModules.push({ name, version });
}

export function getAnnouncedModules(): Array<{ name: string; version: string }> {
  return [...announcedModules];
}

export function trackTool(name: string, source: string): void {
  if (!registeredTools.find((t) => t.name === name)) registeredTools.push({ name, source });
}

export function getRegisteredTools(): Array<{ name: string; source: string }> {
  return [...registeredTools];
}

/** Kept for API compatibility; skills now come from pi's command list. */
export function registerSkillDir(_dir: string): void {}

// ─── pi handles ────────────────────────────────────────────────────────────

let piApi: ExtensionAPI | null = null;
let liveCtx: SessionCtxLike | null = null;

export function setPiApi(api: ExtensionAPI): void {
  piApi = api;
}

let schemaMemo: { key: string; chars: number } | null = null;
/** Characters of the active tools' name + description + JSON schema (what the model receives). */
function toolSchemaChars(): number {
  try {
    const active = piApi?.getActiveTools?.() ?? [];
    const key = active.join(",");
    if (schemaMemo?.key === key) return schemaMemo.chars;
    const set = new Set(active);
    let chars = 0;
    for (const t of piApi?.getAllTools?.() ?? []) {
      if (!set.has(t.name)) continue;
      chars += t.name.length + (t.description?.length ?? 0) + JSON.stringify(t.parameters ?? {}).length;
    }
    schemaMemo = { key, chars };
    return chars;
  } catch {
    return 0;
  }
}

/** Basename of this project's pi session dir (keys usage.compactionByDir). */
export function projectSessionKey(): string | null {
  try {
    const dir = liveCtx?.sessionManager?.getSessionDir?.();
    return dir ? (dir.split(/[/\\]/).filter(Boolean).pop() ?? null) : null;
  } catch {
    return null;
  }
}

/** Latest ExtensionContext (session_start, each turn, and /unipi:info). */
export function setSessionContext(ctx: SessionCtxLike): void {
  liveCtx = ctx;
}

// ─── helpers ───────────────────────────────────────────────────────────────

type SourceInfoLike = { source?: string; scope?: string; origin?: string; path?: string; baseDir?: string };

/** Human label for where a tool/command came from. */
function sourceLabel(info: SourceInfoLike | undefined): string {
  const src = info?.source ?? "";
  if (src === "builtin") return "built-in";
  if (src === "sdk") return "sdk";
  const p = `${info?.path ?? ""} ${info?.baseDir ?? ""} ${src}`;
  if (/@pi-unipi[/\\]|[/\\]unipi[/\\]packages[/\\]|npm:@pi-unipi/.test(p)) return "unipi";
  if (/^npm:/.test(src)) return src.slice(4).replace(/^@[^/]+\//, "").split("@")[0] || "npm";
  if (/^git:/.test(src)) return (src.split("/").pop() ?? "git").replace(/\.git$/, "");
  if (info?.scope === "project") return "project";
  return "local";
}

/** Package-ish name of an extension from its path. */
function extensionName(info: SourceInfoLike | undefined): string {
  const src = info?.source ?? "";
  if (/^npm:/.test(src)) return src.slice(4).replace(/^@[^/]+\//, "").split("@")[0] || src;
  if (/^git:/.test(src)) return (src.split("/").pop() ?? src).replace(/\.git$/, "");
  const path = info?.baseDir ?? info?.path ?? src;
  const parts = path.split(/[/\\]/).filter(Boolean);
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0 && parts[nm + 1]) return parts[nm + 1]!.startsWith("@") ? `${parts[nm + 2] ?? parts[nm + 1]}` : parts[nm + 1]!;
  const last = parts[parts.length - 1] ?? "extension";
  return last.replace(/\.(ts|js|mjs)$/, "") === "index" ? (parts[parts.length - 2] ?? last) : last.replace(/\.(ts|js|mjs)$/, "");
}

// ─── registration ──────────────────────────────────────────────────────────

export function registerCoreGroups(): void {
  // The Compactor page (registered by the compactor module) reads project and
  // global savings from the usage page's parsed history.
  setCompactorHistorySource(() => {
    const u = infoRegistry.getCachedData("usage")?.raw?.raw as UsageRaw | undefined;
    const key = projectSessionKey();
    const g = u?.compaction && u.compaction.count > 0 ? u.compaction : null;
    const pr = key && u?.compactionByDir?.[key] && u.compactionByDir[key]!.count > 0 ? u.compactionByDir[key]! : null;
    return { project: pr, global: g };
  });
  infoRegistry.registerGroup({
    id: "session",
    name: "This session",
    icon: "",
    priority: 10,
    config: {
      showByDefault: true,
      stats: [
        { id: "cost", label: "Cost", show: true },
        { id: "tokens", label: "Tokens", show: true },
        { id: "replies", label: "Replies", show: true },
      ],
    },
    dataProvider: async () => {
      if (!liveCtx) return {};
      let thinking = "";
      try {
        thinking = piApi?.getThinkingLevel?.() ?? "";
      } catch {
        thinking = "";
      }
      return sessionData(collectSession(liveCtx, thinking, toolSchemaChars()));
    },
    render: renderSession,
  });

  infoRegistry.registerGroup({
    id: "usage",
    name: "Usage history",
    icon: "",
    priority: 20,
    config: {
      showByDefault: true,
      stats: [
        { id: "tokensToday", label: "Tokens today", show: true },
        { id: "costToday", label: "Cost today", show: true },
        { id: "costAllTime", label: "Cost all time", show: true },
        { id: "sessions", label: "Sessions", show: true },
      ],
    },
    // Async parser yields to the event loop and reuses its per-file cache.
    dataProvider: async () => usageData(await parseUsageStatsAsync()),
    render: renderUsage,
  });

  infoRegistry.registerGroup({
    id: "tools",
    name: "Tools",
    icon: "",
    priority: 30,
    config: { showByDefault: true, stats: [{ id: "total", label: "Tools", show: true }] },
    dataProvider: async () => {
      let items: Named[] = [];
      let active: Set<string> | null = null;
      try {
        active = new Set(piApi?.getActiveTools?.() ?? []);
      } catch {
        active = null;
      }
      try {
        const all = piApi?.getAllTools?.() ?? [];
        items = all.map((t) => ({ name: t.name, group: sourceLabel(t.sourceInfo as SourceInfoLike), active: active ? active.has(t.name) : true }));
      } catch {
        items = [];
      }
      if (items.length === 0) items = getRegisteredTools().map((t) => ({ name: t.name, group: t.source === "builtin" ? "built-in" : "unipi" }));
      const activeCount = active ? items.filter((i) => i.active).length : undefined;
      return inventoryData(items, activeCount);
    },
    render: (pc) => renderInventory(pc, "tools", "no tools registered", "s"),
  });

  infoRegistry.registerGroup({
    id: "skills",
    name: "Skills",
    icon: "",
    priority: 40,
    config: { showByDefault: true, stats: [{ id: "total", label: "Skills", show: true }] },
    dataProvider: async () => {
      let items: Named[] = [];
      try {
        const cmds = piApi?.getCommands?.() ?? [];
        items = cmds
          .filter((c) => c.source === "skill")
          .map((c) => {
            const info = c.sourceInfo as SourceInfoLike;
            const group = info?.scope === "project" ? "project" : /[/\\]\.agents[/\\]/.test(info?.path ?? "") ? "agents" : sourceLabel(info) === "unipi" ? "unipi" : info?.origin === "package" ? "package" : "user";
            return { name: c.name.replace(/^skill:/, ""), group };
          });
      } catch {
        items = [];
      }
      // Skills install per machine except project-local ones — the tags make
      // that explicit (most skills are global, not session-scoped).
      const groupScopes: Record<string, Scope> = { project: "p", user: "g", agents: "g", unipi: "g", package: "g" };
      return inventoryData(items, undefined, groupScopes);
    },
    render: (pc) => renderInventory(pc, "skills", "add skills under ~/.pi/agent/skills or .pi/skills"),
  });

  infoRegistry.registerGroup({
    id: "extensions",
    name: "Modules",
    icon: "",
    priority: 50,
    config: { showByDefault: true, stats: [{ id: "count", label: "Modules", show: true }] },
    dataProvider: async () => {
      const g = globalThis as {
        __unipi_load_times?: Record<string, number>;
        __unipi_contributions?: Record<string, { tools: string[]; commands: string[]; shortcuts: number }>;
      };
      const times = g.__unipi_load_times ?? {};
      const contrib = g.__unipi_contributions ?? {};
      // Settings fields per namespace (module name, with the hub's aliases).
      const NS_ALIAS: Record<string, string> = { "command-enchantment": "command-enchantment", "skill-registry": "skills" };
      const fields = new Map<string, number>();
      try {
        for (const d of listSettingsDefinitions()) fields.set(d.namespace, (d.schema ?? []).reduce((a, sec) => a + sec.fields.length, 0));
      } catch {
        /* none */
      }
      const names = Object.keys(contrib).length > 0 ? Object.keys(contrib) : getAnnouncedModules().map((m) => m.name.replace(/^@[^/]+\//, ""));
      const unipi = names.map((name) => {
        const c = contrib[name];
        return {
          name,
          ms: times[name] ?? 0,
          tools: c?.tools.length ?? 0,
          commands: c?.commands.length ?? 0,
          shortcuts: c?.shortcuts ?? 0,
          settings: fields.get(NS_ALIAS[name] ?? name) ?? 0,
        };
      });
      // Other (non-unipi) extensions, grouped from tool + command sources.
      const others = new Map<string, { name: string; kind: string; tools: number; commands: number }>();
      const bump = (info: SourceInfoLike | undefined, key: "tools" | "commands"): void => {
        const label = sourceLabel(info);
        if (label === "unipi" || label === "built-in" || label === "sdk") return;
        const name = extensionName(info);
        const e = others.get(name) ?? { name, kind: label, tools: 0, commands: 0 };
        e[key]++;
        others.set(name, e);
      };
      try {
        for (const t of piApi?.getAllTools?.() ?? []) bump(t.sourceInfo as SourceInfoLike, "tools");
        for (const c of piApi?.getCommands?.() ?? []) if (c.source === "extension") bump(c.sourceInfo as SourceInfoLike, "commands");
      } catch {
        /* partial is fine */
      }
      let version = "";
      try {
        version = getInstalledPackageVersion(process.cwd(), "@pi-unipi/unipi");
      } catch {
        version = "";
      }
      const raw: ModulesRaw = {
        version: version && version !== "0.0.0" ? version : (getAnnouncedModules().find((m) => /\d+\.\d+\.\d+-/.test(m.version))?.version ?? ""),
        unipi,
        others: [...others.values()].sort((a, b) => a.name.localeCompare(b.name)),
        totalLoadMs: getTotalLoadTime(),
      };
      return {
        count: { value: String(unipi.length + others.size) },
        raw: { value: "", raw },
      };
    },
    render: renderModules,
  });
}

// ─── splash facts ──────────────────────────────────────────────────────────

let updateLatest: string | null = null;
/** Set by the UPDATE_AVAILABLE listener in index.ts. */
export function setUpdateAvailable(latest: string | null): void {
  updateLatest = latest;
}

/**
 * Cheap, synchronous facts for the startup splash. Only reads memory and the
 * last-session disk snapshot — never parses session history on the boot path.
 */
export function splashFacts(): import("./tui/splash.js").SplashFacts {
  let tools: number | undefined;
  try {
    tools = piApi?.getAllTools?.().length;
  } catch {
    tools = undefined;
  }
  const usage = infoRegistry.getCachedData("usage")?.raw?.raw as { cost?: { today?: number }; sessionsToday?: number } | undefined;
  // The usage snapshot may be from a previous day; only trust it for today.
  const usageAt = infoRegistry.getLastUpdated("usage");
  const sameDay = usageAt > 0 && new Date(usageAt).toDateString() === new Date().toDateString();
  let resumed: import("./tui/splash.js").SplashFacts["resumed"] = null;
  let cwd: string | undefined;
  let branch: string | null = null;
  if (liveCtx) {
    try {
      const raw = collectSession(liveCtx, "");
      cwd = raw.cwd.replace(process.env.HOME ?? "\u0000", "~");
      branch = raw.branch;
      if (raw.replies > 0) {
        const total = raw.input + raw.output + raw.cacheRead + raw.cacheWrite;
        resumed = { replies: raw.replies, tokens: compactNum(total), cost: raw.cost > 0 ? `$${raw.cost.toFixed(2)}` : "$0" };
      }
    } catch {
      /* cosmetic */
    }
  }
  const unipiModules = (globalThis as { __unipi_load_times?: Record<string, number> }).__unipi_load_times;
  return {
    modules: unipiModules ? Object.keys(unipiModules).length : getAnnouncedModules().length || undefined,
    tools,
    todayCost: sameDay ? usage?.cost?.today : undefined,
    todaySessions: sameDay ? usage?.sessionsToday : undefined,
    resumed,
    cwd,
    branch,
    update: updateLatest,
  };
}

function compactNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
