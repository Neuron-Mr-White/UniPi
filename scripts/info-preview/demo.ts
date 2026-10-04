// Demo data for README screenshots: a believable session and machine history,
// no real spend or paths. Use as INFO_PREVIEW_EXTRA (after mock-modules.ts):
//
//   INFO_PREVIEW_EXTRA=scripts/info-preview/demo.ts npx tsx scripts/info-preview/index.ts all 120
import "./mock-modules.ts";
import { infoRegistry } from "../../packages/info-screen/registry.ts";
import * as core from "../../packages/info-screen/core-groups.ts";
import { usageData, renderUsage } from "../../packages/info-screen/pages/usage.ts";

const now = Date.now();
const H = 3_600_000;
let seed = 7;
const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ── a 2h40m session: 64 replies, growing context, one compaction ──────────
const branch: unknown[] = [];
let ctx = 18_000;
const tools = ["bash", "read", "edit", "grep", "read", "bash", "write", "find", "memory_search", "edit", "bash", "read"];
let id = 0;
const ts = (i: number): string => new Date(now - 2.67 * H + i * 150_000).toISOString();
branch.push({ type: "message", id: `e${id++}`, timestamp: ts(0), message: { role: "user", content: "Add retry with backoff to the sync client and cover it with tests." } });
for (let i = 1; i <= 64; i++) {
  if (i === 38) {
    branch.push({ type: "compaction", id: `e${id++}`, timestamp: ts(i), tokensBefore: ctx, details: { compactor: "@pi-unipi/compactor", tokensAfter: 24_000 } });
    ctx = 24_000;
  }
  if (i % 16 === 0) branch.push({ type: "message", id: `e${id++}`, timestamp: ts(i), message: { role: "user", content: "Looks good — now handle the 429 case too." } });
  ctx += Math.round(2_000 + rnd() * 3_500);
  const name = tools[i % tools.length]!;
  const cacheRead = Math.round(ctx * 0.9);
  branch.push({
    type: "message",
    id: `e${id++}`,
    timestamp: ts(i),
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      usage: { input: ctx - cacheRead, output: Math.round(300 + rnd() * 1500), cacheRead, cacheWrite: 1200, cost: { input: (ctx - cacheRead) * 3e-6, cacheRead: cacheRead * 0.3e-6, cacheWrite: 1200 * 3.75e-6, output: 0.012, total: (ctx - cacheRead) * 3e-6 + cacheRead * 0.3e-6 + 0.0045 + 0.012 } },
      content: [{ type: "text", text: "…" }, { type: "toolCall", id: `t${i}`, name, arguments: name === "edit" || name === "write" ? { path: `src/sync/${["client", "retry", "backoff"][i % 3]}.ts` } : {} }],
    },
  });
  branch.push({ type: "message", id: `e${id++}`, timestamp: ts(i), message: { role: "toolResult", toolCallId: `t${i}`, toolName: name, isError: i === 9 || i === 27 || i === 51, content: [] } });
}

// What pi would send next (drives the context bucket).
const big = (n: number): string => "x".repeat(n);
const messages = [
  { role: "compactionSummary", summary: big(26_000) },
  { role: "user", content: big(2_400) },
  ...Array.from({ length: 26 }, (_, i) => [
    { role: "assistant", content: [{ type: "text", text: big(1_900 + (i % 5) * 300) }] },
    { role: "toolResult", toolName: ["bash", "read", "grep", "read", "edit"][i % 5], content: [{ type: "text", text: big([7_000, 9_500, 2_200, 6_000, 600][i % 5]!) }] },
  ]).flat(),
];

core.setSessionContext({
  cwd: "/home/you/code/sync-service",
  model: { name: "Claude Sonnet 5", provider: "anthropic", contextWindow: 400_000 },
  getContextUsage: () => ({ tokens: ctx, contextWindow: 400_000, percent: (ctx / 400_000) * 100 }),
  getSystemPrompt: () => big(19_000),
  sessionManager: {
    getBranch: () => branch,
    getLeafId: () => `e${id - 1}`,
    getSessionDir: () => "/home/you/.pi/agent/sessions/--home-you-code-sync-service--",
    buildSessionProjection: () => ({ messages }),
  },
} as never);

// ── 30 days of machine history ─────────────────────────────────────────────
const daily = Array.from({ length: 30 }, (_, i) => {
  const dow = new Date(now - (29 - i) * 86_400_000).getDay();
  const weekend = dow === 0 || dow === 6;
  const cost = weekend ? rnd() * 1.2 : 2 + rnd() * 9 + (i > 24 ? 6 : 0);
  return { cost, tokens: Math.round(cost * 420_000) };
});
daily[29] = { cost: 6.84, tokens: 2_900_000 };
const sum = (n: number): number => daily.slice(-n).reduce((a, d) => a + d.cost, 0);
const stats = {
  tokens: { today: 2_900_000, week: Math.round(sum(5) * 420_000), month: Math.round(sum(30) * 420_000) },
  cost: { today: 6.84, allTime: 612.4 },
  byModel: {},
  byModelToday: {},
  byModelWeek: { a: { tokens: 0, cost: sum(5), sessions: 0 } },
  byModelMonth: {
    "claude-sonnet-5": { tokens: 41_000_000, cost: sum(30) * 0.62, sessions: 40 },
    "gpt-5.5": { tokens: 18_000_000, cost: sum(30) * 0.27, sessions: 14 },
    "gemini-3.8-flash": { tokens: 22_000_000, cost: sum(30) * 0.08, sessions: 30 },
    "deepseek-v4": { tokens: 9_000_000, cost: sum(30) * 0.03, sessions: 6 },
  },
  sessionCount: 214,
  sessionsToday: 4,
  daily,
  compaction: { count: 131, saved: 19_400_000, avoided: 2_310_000_000, dollars: 184.6, sent: 3_900_000_000 },
  compactionByDir: { "--home-you-code-sync-service--": { count: 22, saved: 3_100_000, avoided: 361_000_000, dollars: 31.9, sent: 610_000_000 } },
};
infoRegistry.registerGroup({
  id: "usage",
  name: "Usage history",
  icon: "",
  priority: 20,
  config: { showByDefault: true, stats: [] },
  dataProvider: async () => usageData(stats as never),
  render: renderUsage,
});
infoRegistry.invalidateCache("session");
