#!/usr/bin/env -S npx tsx
// Print the Unicrab splash and every /unipi:info page at several widths,
// without a pi session. Uses this machine's real usage history and the most
// recent session file for the "This session" page.
//
//   npx tsx scripts/info-preview/index.ts [page|splash|all] [width,width…] [--plain]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/theme/theme.js")).href)) as { getThemeByName(n: string): unknown };
const theme = themeMod.getThemeByName("dark");

const { infoRegistry } = await import("../../packages/info-screen/registry.ts");
infoRegistry.persist = false;
const core = await import("../../packages/info-screen/core-groups.ts");
const { InfoOverlay } = await import("../../packages/info-screen/tui/info-overlay.ts");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const plain = process.argv.includes("--plain");
const which = args[0] ?? "all";
const widths = (args[1] ?? "60,100").split(",").map(Number);

// Most recent session → fake ExtensionContext.
function latestSession(): string | null {
  const root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
  let best: [number, string] | null = null;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const m = statSync(p).mtimeMs;
        if (!best || m > best[0]) best = [m, p];
      }
    }
  };
  try { walk(root); } catch { /* none */ }
  return best ? (best as [number, string])[1] : null;
}
const file = latestSession();
const entries = file ? readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const header = entries.find((e: any) => e.type === "session");
const { buildSessionProjection } = (await import("@earendil-works/pi-coding-agent")) as unknown as { buildSessionProjection: (e: unknown[], leaf?: string | null) => { messages: unknown[] } };
const branch = entries.filter((e: any) => e.type !== "session");
const lastModel = [...branch].reverse().find((e: any) => e.message?.role === "assistant")?.message;
const ctxTokens = lastModel ? (lastModel.usage?.input ?? 0) + (lastModel.usage?.cacheRead ?? 0) + (lastModel.usage?.cacheWrite ?? 0) : 0;
core.setSessionContext({
  cwd: header?.cwd ?? process.cwd(),
  model: { name: lastModel?.model ?? "claude-opus", provider: lastModel?.provider ?? "anthropic", contextWindow: 1_000_000 },
  getContextUsage: () => ({ tokens: ctxTokens, contextWindow: 1_000_000, percent: (ctxTokens / 1_000_000) * 100 }),
  sessionManager: {
    getBranch: () => branch,
    getLeafId: () => branch[branch.length - 1]?.id ?? null,
    getHeader: () => header,
    getSessionName: () => undefined,
    buildSessionProjection: () => buildSessionProjection(branch as never, branch[branch.length - 1]?.id ?? null),
  },
  getSystemPrompt: () => "You are pi. ".repeat(900),
});
core.setPiApi({
  getThinkingLevel: () => "high",
  getActiveTools: () => ["read", "bash", "edit", "write", "grep", "find", "ls", "memory_search", "memory_store", "web_search", "ask_user", "kanboard"],
  getAllTools: () => [
    ...["read", "bash", "edit", "write", "grep", "find", "ls"].map((n) => ({ name: n, description: "x".repeat(600), parameters: { type: "object", properties: { path: { type: "string", description: "y".repeat(200) } } }, sourceInfo: { source: "builtin" } })),
    ...["memory_search", "memory_store", "memory_delete", "web_search", "web_read", "ask_user", "kanboard", "bg_run", "bg_status", "bg_logs", "run_subagent", "read_subagent", "mcp_call"].map((n) => ({ name: n, sourceInfo: { source: "npm:@pi-unipi/unipi", path: "/x/node_modules/@pi-unipi/unipi/index.ts" } })),
    ...["ffgrep", "fffind"].map((n) => ({ name: n, sourceInfo: { source: "npm:pi-fff", path: "/x/node_modules/pi-fff/index.ts" } })),
  ],
  getCommands: () => [
    ...["summarize", "show-me", "brainstorm", "plan", "work", "review", "kanboard", "humanizer", "ste100"].map((n, i) => ({ name: `skill:${n}`, source: "skill", sourceInfo: { path: i < 4 ? "/x/@pi-unipi/unipi/skills" : "/home/u/.agents/skills/x", scope: "user" } })),
    { name: "fff", source: "extension", sourceInfo: { source: "npm:pi-fff", path: "/x/node_modules/pi-fff/index.ts" } },
  ],
} as never);
for (const [n, v, ms] of [["workflow", "3.0.0-alpha.24", 12], ["memory", "3.0.0-alpha.24", 48], ["subagents", "3.0.0-alpha.24", 31], ["kanboard", "3.0.0-alpha.24", 22], ["web-api", "3.0.0-alpha.24", 9], ["mcp", "3.0.0-alpha.24", 64], ["footer", "3.0.0-alpha.24", 18], ["compactor", "0.2.0", 7]] as const) {
  core.trackModule(n, v);
  core.recordLoadTime(n, "module", ms);
}
(globalThis as Record<string, unknown>).__unipi_contributions = Object.fromEntries(
  ([["workflow", 2, 14, 0], ["long-horizon", 3, 6, 1], ["memory", 6, 7, 0], ["utility", 1, 9, 2], ["skill-registry", 0, 2, 0], ["info-screen", 0, 1, 0], ["subagents", 3, 2, 1], ["background-tasks", 4, 1, 0], ["btw", 0, 1, 0], ["web-api", 3, 2, 0], ["ask-user", 1, 1, 0], ["mcp", 0, 3, 0], ["notify", 1, 4, 0], ["kanboard", 1, 3, 0], ["command-enchantment", 0, 0, 0], ["compactor", 2, 3, 0], ["footer", 0, 2, 1], ["updater", 0, 3, 0], ["input-shortcuts", 0, 0, 3], ["fusion", 2, 4, 0], ["watchdog", 0, 1, 0]] as const).map(([n, t, c, k]) => [n, { tools: Array(t).fill("x"), commands: Array(c).fill("y"), shortcuts: k }]),
);
(globalThis as Record<string, unknown>).__unipi_load_times = { workflow: 4.1, "long-horizon": 6.3, memory: 31.2, utility: 3.3, "skill-registry": 1.1, "info-screen": 0.8, subagents: 2.2, "background-tasks": 1.4, btw: 0.4, "web-api": 9.7, "ask-user": 0.9, mcp: 1.8, notify: 2.4, kanboard: 1.7, "command-enchantment": 0.5, compactor: 3.9, footer: 2.8, updater: 0.6, "input-shortcuts": 0.7, fusion: 2.0, watchdog: 0.3 };
// Settings namespaces, as the real modules register them.
await import("../../packages/info-screen/config.ts");
core.registerCoreGroups();
const extra = process.env.INFO_PREVIEW_EXTRA;
if (extra) await import(pathToFileURL(extra).href);

const ids = infoRegistry.getAllGroups().map((g) => g.id);
await Promise.all(ids.map((id) => infoRegistry.getGroupData(id)));

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
const show = (lines: string[], w: number): void => {
  for (const l of lines) {
    const vw = visibleWidth(l);
    if (vw > w) console.log(`!! overflow ${vw} > ${w}`);
    console.log(plain ? strip(l) : l);
  }
};

if (which === "splash" || which === "all") {
  try {
    const { renderSplash } = await import("../../packages/info-screen/tui/splash.ts");
    for (const w of widths) {
      console.log(`\n── splash @ ${w} ──`);
      show(renderSplash({ width: w, theme: theme as never, unipiVersion: "3.0.0-alpha.24", piVersion: "0.87.1", readyMs: 412, facts: core.splashFacts?.() }), w);
    }
  } catch (e) {
    if (which === "splash") throw e;
  }
}
if (which !== "splash") {
  const pages = which === "all" ? ids : [which];
  for (const id of pages) {
    for (const w of widths) {
      const o = new InfoOverlay(id);
      o.setTheme(theme as never);
      o.terminalRows = () => Number(process.env.ROWS ?? 34);
      console.log(`\n── ${id} @ ${w} ──`);
      show(o.render(w), w);
      o.destroy();
    }
  }
}
process.exit(0);
