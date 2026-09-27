/**
 * Three-way compactor comparison at a real compaction point of a recorded
 * session: Pi's model-written summary (the reference), lossless + jev, and
 * lossless (vcc). All three summarize the same history and keep the same tail
 * (the lossless cut), so only the summary differs.
 *
 *   npx tsx scripts/compactor-three-way.mts <out-dir> <model-id> <session.jsonl[:idx]>...
 *
 * Needs ~/.pi/agent/models.json (the model's provider entry) and a jev key
 * (OPENROUTER_API_KEY). Writes per case:
 *   <slug>.{llm,jev,vcc}.jsonl   resumable sessions (branch + that compaction)
 *   <slug>.{llm,jev,vcc}.md      the summaries
 *   <slug>.next.md               what really happened afterwards
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { convertToLlm, generateSummaryWithUsage, serializeConversation } from "@earendil-works/pi-coding-agent";
import { planJevCompaction, planLosslessCompaction } from "../packages/compactor/src/compaction/hooks.ts";
import { pruneWithJev } from "../packages/compactor/src/compaction/jev-prune.ts";
import { DEFAULT_COMPACTOR_CONFIG } from "../packages/compactor/src/config/schema.ts";
import { textOf } from "../packages/compactor/src/compaction/content.ts";
import { collectOrigins, isInjectedUserText } from "../packages/compactor/src/compaction/source.ts";

const [outDir, modelId, ...specs] = process.argv.slice(2);
if (!outDir || !modelId || specs.length === 0) {
  console.error("usage: compactor-three-way.mts <out-dir> <model-id> <session.jsonl[:idx]>...");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// ── model from pi's registry file ────────────────────────
const registry = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"));
let model: any;
let apiKey: string | undefined;
for (const [provider, p] of Object.entries<any>(registry.providers ?? {})) {
  const m = (p.models ?? []).find((x: any) => x.id === modelId);
  if (m) {
    model = { ...m, provider, api: m.api ?? p.api, baseUrl: m.baseUrl ?? p.baseUrl };
    apiKey = p.apiKey;
    break;
  }
}
if (!model) throw new Error(`model ${modelId} not in models.json`);
// The omniroute bridge keeps the live key in its own config.
const bridgeConfig = join(homedir(), ".pi", "agent", "omniroute-bridge", "config.json");
if (model.provider === "omniroute" && existsSync(bridgeConfig)) {
  const bridge = JSON.parse(readFileSync(bridgeConfig, "utf8"));
  apiKey = bridge.apiKey ?? bridge.key ?? apiKey;
}

const JEV = { provider: "openrouter" as const, model: "typesafe/jev-1.13", baseUrl: "", apiKey: "", timeoutMs: 20_000 };
/** Serialized chars per summarization call (Pi-style chained updates beyond this). */
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? 600_000);

/** Provider routes drop large streams under load: retry with backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 30_000 * i));
    }
  }
}

const flat = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

async function llmSummary(messages: any[]): Promise<{ text: string; calls: number; chars: number }> {
  // Chunk at message boundaries by serialized size, then chain like Pi's
  // repeated compactions (previousSummary → update prompt).
  const chunks: any[][] = [];
  let cur: any[] = [];
  let size = 0;
  let total = 0;
  for (const m of messages) {
    const s = serializeConversation(convertToLlm([m])).length;
    total += s;
    if (size + s > CHUNK_CHARS && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += s;
  }
  if (cur.length) chunks.push(cur);
  let summary: string | undefined;
  for (const chunk of chunks) {
    const r = await withRetry(() => generateSummaryWithUsage(chunk, model, Number(process.env.RESERVE_TOKENS ?? 32768), apiKey, undefined, undefined, undefined, summary));
    summary = r.text;
  }
  return { text: summary ?? "", calls: chunks.length, chars: total };
}

/** Screenshots are base64 megabytes no summarizer reads: replace with a marker. */
function dropImages(entry: any): any {
  const strip = (content: unknown) =>
    Array.isArray(content) ? content.map((c: any) => (c?.type === "image" ? { type: "text", text: "[image omitted]" } : c)) : content;
  if (entry?.message?.content) entry.message.content = strip(entry.message.content);
  if (entry?.content) entry.content = strip(entry.content);
  return entry;
}

process.on("uncaughtException", (err) => {
  console.log(`FATAL ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

for (const spec of specs) {
  const [file, which] = spec.split(/:(?=[^/]*$)/);
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [dropImages(JSON.parse(l))];
    } catch {
      return [];
    }
  });
  const header = entries.find((e) => e.type === "session");
  const withId = entries.filter((e) => e.id);
  const byId = new Map(withId.map((e) => [e.id, e]));
  const children = new Map<string, any[]>();
  for (const e of withId) if (e.parentId) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e]);
  const compactions = withId.filter((e) => e.type === "compaction");
  const idx = which !== undefined ? Number(which) : compactions.length - 1;
  const target = compactions[idx];
  if (!target) continue;
  const slug = basename(join(file, "..")).replace(/^--home-oi-Projects-|--$/g, "").slice(0, 40) + `-c${idx}`;
  // An existing model summary is reused (expensive); jev/vcc are always rebuilt.
  const cachedLlm = existsSync(join(outDir, `${slug}.llm.md`)) ? readFileSync(join(outDir, `${slug}.llm.md`), "utf8") : null;
  const branch: any[] = [];
  for (let c = byId.get(target.parentId); c; c = byId.get(c.parentId)) branch.unshift(c);
  const input = { branchEntries: branch, tokensBefore: target.tokensBefore, config: DEFAULT_COMPACTOR_CONFIG, cwd: header?.cwd };

  const t0 = Date.now();
  const vcc = planLosslessCompaction(input);
  if (!vcc.ok) continue;
  const tVcc = Date.now() - t0;
  const t1 = Date.now();
  const jev = await planJevCompaction(input, (c, s) => pruneWithJev(c, s, JEV));
  if (!jev.ok) continue;
  const tJev = Date.now() - t1;

  // Common cut: the lossless tail; the model summarizes everything before it.
  const keptIdx = vcc.firstKeptEntryId ? branch.findIndex((e) => e.id === vcc.firstKeptEntryId) : branch.length;
  const toSummarize = branch.slice(0, keptIdx < 0 ? branch.length : keptIdx).filter((e) => e.type === "message").map((e) => e.message);
  const t2 = Date.now();
  let llm: { text: string; calls: number; chars: number };
  try {
    llm = cachedLlm ? { text: cachedLlm, calls: 0, chars: 0 } : await llmSummary(toSummarize);
  } catch (err) {
    console.log(`${slug}\tLLM FAILED: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const tLlm = Date.now() - t2;
  // Persist the expensive part first.
  if (!cachedLlm) writeFileSync(join(outDir, `${slug}.llm.md`), llm.text);

  const head = { ...header, id: randomUUID(), timestamp: new Date().toISOString() };
  const write = (kind: string, summary: string, details: unknown) => {
    const compaction = { ...target, id: randomUUID().slice(0, 8), summary, firstKeptEntryId: vcc.firstKeptEntryId, details, fromHook: true };
    const path = join(outDir, `${slug}.${kind}.jsonl`);
    writeFileSync(path, "");
    for (const e of [head, ...branch, compaction]) appendFileSync(path, JSON.stringify(e) + "\n");
    writeFileSync(join(outDir, `${slug}.${kind}.md`), summary);
  };
  write("vcc", vcc.summary, vcc.details);
  write("jev", jev.summary, jev.details);
  write("llm", llm.text, { method: "llm-reference", model: modelId, calls: llm.calls });

  const origins = collectOrigins(branch);
  const next: string[] = [];
  let c = target;
  for (let n = 0; n < 600 && next.length < 14; n++) {
    const child = children.get(c.id)?.[0];
    if (!child) break;
    c = child;
    if (child.type !== "message") continue;
    const m = child.message;
    if (m.role === "user") {
      const t = textOf(m.content);
      next.push(`${isInjectedUserText(t, origins) ? "[injected]" : "[USER]"} ${flat(t, 600)}`);
    } else if (m.role === "assistant") {
      const text = (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
      const tools = (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "toolCall").map((p: any) => `${p.name}(${flat(JSON.stringify(p.arguments ?? {}), 140)})`);
      if (text.trim() || tools.length) next.push(`[assistant] ${flat(text, 500)}${tools.length ? ` {${tools.slice(0, 3).join("; ")}}` : ""}`);
    }
  }
  writeFileSync(join(outDir, `${slug}.next.md`), [`# ${slug}`, "", "## What happened next", ...next.map((l) => `- ${l}`)].join("\n"));
  const stats = {
    slug,
    entries: branch.length,
    summarizedChars: llm.chars,
    keptTokens: vcc.stats.keptTokensEst,
    chars: { llm: llm.text.length, jev: jev.summary.length, vcc: vcc.summary.length },
    ms: { llm: tLlm, jev: tJev, vcc: tVcc },
    llmCalls: llm.calls,
    jev: jev.details.jev,
  };
  const statsPath = join(outDir, `${slug}.stats.json`);
  if (cachedLlm && existsSync(statsPath)) {
    const prev = JSON.parse(readFileSync(statsPath, "utf8"));
    Object.assign(stats, { summarizedChars: prev.summarizedChars, llmCalls: prev.llmCalls, ms: { ...stats.ms, llm: prev.ms?.llm } });
  }
  writeFileSync(statsPath, JSON.stringify(stats, null, 1));
  console.log(`${slug}\tllm ${llm.text.length}c/${Math.round(tLlm / 1000)}s(${llm.calls})\tjev ${jev.summary.length}c/${tJev}ms\tvcc ${vcc.summary.length}c/${tVcc}ms`);
}
