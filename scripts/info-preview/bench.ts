// Rough timings for the info screen's hot paths.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const t = (label: string, fn: () => unknown, n = 1): void => {
  const s = performance.now();
  for (let i = 0; i < n; i++) fn();
  console.log(`${label.padEnd(44)} ${((performance.now() - s) / n).toFixed(2)} ms`);
};
const { infoRegistry } = await import("../../packages/info-screen/registry.ts");
infoRegistry.persist = false;
const core = await import("../../packages/info-screen/core-groups.ts");
const { InfoOverlay } = await import("../../packages/info-screen/tui/info-overlay.ts");
const { renderSplash } = await import("../../packages/info-screen/tui/splash.ts");
const { collectSession } = await import("../../packages/info-screen/pages/session.ts");
// biggest session file
const root = join(homedir(), ".pi", "agent", "sessions");
let big: [number, string] = [0, ""];
for (const d of readdirSync(root).filter((x) => statSync(join(root, x)).isDirectory())) for (const f of readdirSync(join(root, d))) { const p = join(root, d, f); if (!p.endsWith(".jsonl")) continue; const s = statSync(p).size; if (s > big[0]) big = [s, p]; }
const entries = readFileSync(big[1], "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log(`largest session: ${(big[0] / 1e6).toFixed(0)} MB, ${entries.length} entries`);
let leaf = "a";
const ctx = { cwd: process.cwd(), model: { name: "m", contextWindow: 200000 }, getContextUsage: () => ({ tokens: 1, contextWindow: 200000, percent: 1 }), sessionManager: { getBranch: () => entries, getLeafId: () => leaf } };
t("collectSession cold (walk branch)", () => { leaf = String(Math.random()); collectSession(ctx as never, "high"); }, 5);
t("collectSession memo hit", () => collectSession(ctx as never, "high"), 1000);
core.setSessionContext(ctx as never);
core.setPiApi({ getAllTools: () => [], getActiveTools: () => [], getCommands: () => [], getThinkingLevel: () => "high" } as never);
core.registerCoreGroups();
await infoRegistry.getGroupData("session");
let s = performance.now();
await infoRegistry.forceRefresh("usage");
console.log(`${"usage page data (parser, warm file cache)".padEnd(44)} ${(performance.now() - s).toFixed(2)} ms`);
const o = new InfoOverlay("session");
t("dashboard first render @120 (session)", () => { o.invalidate(); o.render(120); }, 20);
t("dashboard re-render @120 (memo)", () => o.render(120), 200);
const u = new InfoOverlay("usage");
t("dashboard first render @120 (usage)", () => { u.invalidate(); u.render(120); }, 20);
t("splash render @100", () => renderSplash({ width: 100, unipiVersion: "3.0.0-alpha.24", piVersion: "0.87.1", readyMs: 400, facts: {} }), 200);
t("splashFacts()", () => core.splashFacts(), 50);
process.exit(0);
