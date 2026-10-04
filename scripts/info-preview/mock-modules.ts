// Mock module pages for the preview (what the real modules register at runtime).
import { infoRegistry } from "../../packages/info-screen/registry.ts";
const reg = (id: string, name: string, stats: string[], data: Record<string, unknown>) =>
  infoRegistry.registerGroup({ id, name, icon: "", priority: 0, config: { showByDefault: true, stats: stats.map((s) => ({ id: s, label: s, show: true })) }, dataProvider: async () => data as never });
const now = Date.now();
reg("mcp", "MCP servers", ["total"], { raw: { value: "", raw: { servers: [
  { name: "github", status: "running", tools: 26 }, { name: "context7", status: "running", tools: 2 },
  { name: "playwright", status: "error", tools: 0, error: "spawn npx ENOENT — is node on PATH?" }, { name: "linear", status: "starting", tools: 0 },
] } } });
reg("compactor", "Compactor", ["settings"], { raw: { value: "", raw: { method: "lossless", trigger: "at Pi's context limit", piCompact: "same as method", before: 412000, after: 61000, saved: 351000,
  history: [{ before: 180000, after: 22000, method: "lossless", at: now - 3_600_000 }, { before: 165000, after: 19000, method: "lossless", at: now - 1_800_000 }, { before: 67000, after: 20000, method: "model summary", at: now - 600_000 }],
  items: [
    { at: now - 3_600_000, before: 180000, after: 22000, replies: 41, paid: 1.9, context: 2_100_000 },
    { at: now - 1_800_000, before: 165000, after: 19000, replies: 33, paid: 1.4, context: 1_600_000 },
    { at: now - 600_000, before: 67000, after: 20000, replies: 9, paid: 0.2, context: 260_000 },
  ],
  session: { count: 3, saved: 351000, avoided: 12_741_000, dollars: 11.2, sent: 3_960_000 } } } });
reg("updater", "Updates", ["current"], { raw: { value: "", raw: { current: "3.0.0-alpha.24", latest: "3.0.0-alpha.25", available: true, checkedAt: now - 120_000, mode: "notify" } } });
reg("web-api", "Web API", ["providers"], { raw: { value: "", raw: {
  providers: [
    { id: "wigolo", name: "wigolo", caps: ["search", "read"], enabled: true, keyed: false, hasKey: true },
    { id: "duckduckgo", name: "DuckDuckGo", caps: ["search"], enabled: true, keyed: false, hasKey: true },
    { id: "jina-reader", name: "Jina Reader", caps: ["read"], enabled: true, keyed: false, hasKey: true },
    { id: "tavily", name: "Tavily", caps: ["search", "read"], enabled: true, keyed: true, hasKey: false },
    { id: "perplexity", name: "Perplexity", caps: ["search", "summarize"], enabled: false, keyed: true, hasKey: false },
  ],
  tools: { web_search: true, multi_web_content_read: true, web_llm_summarize: false }, smartFetch: null, wigolo: "✓ Installed",
  cache: { entries: 1834, bytes: 48_200_000, expired: 212 } } } });
reg("memory", "Memory", ["projectCount"], { raw: { value: "", raw: { project: "unipi", projectCount: 419, total: 1288, types: { decision: 120, pattern: 98, summary: 171, preference: 30 }, recall: true, write: true, pending: 2, migrate: null } } });
reg("input-shortcuts", "Input shortcuts", ["chordKey"], { raw: { value: "", raw: { chordKey: "alt+s", tabInsertKey: "ctrl+t", stash: 0 } } });
