/**
 * Judge the three-way compactor comparison produced by compactor-three-way.mts.
 *
 *   npx tsx scripts/compactor-judge.mts <dir> <model-id> [slug...]
 *
 * Per case:
 *   1. facts   — the model lists the 25 facts from the LLM reference that matter
 *                most for continuing; each is checked against jev and vcc
 *                (summary + the shared kept tail): present / partial / missing /
 *                contradicted.
 *   2. stale   — items in each summary that are outdated, wrong or irrelevant.
 *   3. resume  — if <slug>.<kind>.answer.md exist (pi --fork -nt -p answers), the
 *                three answers are shuffled, labelled A/B/C and scored 1-10
 *                against what actually happened next.
 * Writes <slug>.judge.json and prints a table.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const [dir, modelId, ...only] = process.argv.slice(2);
const registry = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"));
let model: any;
let apiKey: string | undefined;
for (const [provider, p] of Object.entries<any>(registry.providers ?? {})) {
  const m = (p.models ?? []).find((x: any) => x.id === modelId);
  if (m) {
    model = { ...m, provider, api: m.api ?? p.api, baseUrl: m.baseUrl ?? p.baseUrl };
    apiKey = p.apiKey;
  }
}
const bridge = join(homedir(), ".pi", "agent", "omniroute-bridge", "config.json");
if (model?.provider === "omniroute" && existsSync(bridge)) apiKey = JSON.parse(readFileSync(bridge, "utf8")).apiKey ?? apiKey;
if (!model) throw new Error(`model ${modelId} not found`);

async function ask(prompt: string, attempt = 1): Promise<any> {
  const res: any = await completeSimple(
    model,
    { systemPrompt: "You are a meticulous evaluator. Reply with a single JSON object and nothing else.", messages: [{ role: "user", content: prompt, timestamp: Date.now() }] } as any,
    { apiKey, maxTokens: 16000, signal: AbortSignal.timeout(300_000) } as any,
  ).catch((err: unknown) => ({ content: [], stopReason: "error", errorMessage: String(err) }));
  const text = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  try {
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 20_000 * attempt));
      return ask(prompt, attempt + 1);
    }
    throw new Error(`judge reply unusable (stop=${res.stopReason} err=${res.errorMessage ?? ""}): ${text.slice(0, 300)}`);
  }
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

function keptTail(slug: string): string {
  const lines = read(join(dir, `${slug}.vcc.jsonl`)).trim().split("\n").map((l) => JSON.parse(l));
  const compaction = lines[lines.length - 1];
  const idx = lines.findIndex((e) => e.id === compaction.firstKeptEntryId);
  if (idx < 0) return "(no kept messages)";
  const msgs = lines.slice(idx, -1).filter((e) => e.type === "message").map((e) => e.message);
  const text = serializeConversation(convertToLlm(msgs));
  return text.length > 120_000 ? `…${text.slice(-120_000)}` : text;
}

const slugs = [...new Set(readdirSync(dir).filter((f) => f.endsWith(".stats.json")).map((f) => f.replace(/\.stats\.json$/, "")))]
  .filter((s) => only.length === 0 || only.includes(s));

const table: string[] = [];
for (const slug of slugs) {
  const out = join(dir, `${slug}.judge.json`);
  if (existsSync(out) && only.length === 0) {
    table.push(summarize(slug, JSON.parse(read(out))));
    continue;
  }
  const llm = read(join(dir, `${slug}.llm.md`));
  const jev = read(join(dir, `${slug}.jev.md`));
  const vcc = read(join(dir, `${slug}.vcc.md`));
  const tail = keptTail(slug);
  const next = read(join(dir, `${slug}.next.md`));

  const facts = await ask(
    `Below is a trusted summary of a long coding-agent session, written by a strong model at a context compaction point.\n` +
      `List the 25 facts a developer taking over MUST know to continue the work correctly (current task, what is done, next steps, user decisions and constraints, key technical facts such as paths/commands/names). Most important first; one short sentence each.\n` +
      `Return {"facts": [string, ...]}.\n\n=== TRUSTED SUMMARY ===\n${llm}`,
  );

  const check = async (label: string, summary: string) =>
    ask(
      `A developer resumes a session with ONLY the SUMMARY below plus the RECENT MESSAGES that were kept verbatim.\n` +
        `For each FACT, decide if the developer has it: "present" (clearly stated), "partial" (hinted or incomplete), "missing", or "contradicted" (they are told something different).\n` +
        `Then list up to 10 items in the SUMMARY (not the recent messages) that are stale, wrong, or irrelevant noise for continuing.\n` +
        `Return {"verdicts": ["present"|"partial"|"missing"|"contradicted", ...one per fact in order], "stale": [string, ...]}.\n\n` +
        `=== FACTS ===\n${facts.facts.map((f: string, i: number) => `${i + 1}. ${f}`).join("\n")}\n\n=== SUMMARY (${label}) ===\n${summary}\n\n=== RECENT MESSAGES ===\n${tail}`,
    );
  // Sequential: the provider route has a small concurrency limit.
  const jevCheck = await check("A", jev);
  const vccCheck = await check("B", vcc);
  const llmStale = await ask(`List up to 10 items in this SUMMARY that are stale, wrong, or irrelevant noise for continuing the work, judging by the RECENT MESSAGES. Return {"stale": [string, ...]}.\n\n=== SUMMARY ===\n${llm}\n\n=== RECENT MESSAGES ===\n${tail}`);

  let resume: any = null;
  const answers = ["llm", "jev", "vcc"].map((k) => ({ k, a: read(join(dir, `${slug}.${k}.answer.md`)) }));
  if (answers.every((x) => x.a.trim())) {
    const order = answers.map((x) => x).sort(() => Math.random() - 0.5);
    const labels = ["A", "B", "C"];
    const r = await ask(
      `Three agents resumed the same coding session after a context compaction, each given a different summary. Each wrote what it believes is the current request, what is done, the next action, constraints and open questions.\n` +
        `Compare each answer to WHAT ACTUALLY HAPPENED NEXT. Score 1-10 for: request (current request right), next (next action matches what was actually done or clearly right), constraints (correct standing constraints, none invented), accuracy (no false claims about state). Also give overall 1-10 and one-line reason.\n` +
        `Return {"A": {"request":n,"next":n,"constraints":n,"accuracy":n,"overall":n,"why":"..."}, "B": {...}, "C": {...}}.\n\n` +
        order.map((x, i) => `=== ANSWER ${labels[i]} ===\n${x.a}`).join("\n\n") +
        `\n\n=== WHAT ACTUALLY HAPPENED NEXT ===\n${next}`,
    );
    resume = Object.fromEntries(order.map((x, i) => [x.k, r[labels[i]]]));
  }

  const result = { slug, facts: facts.facts, jev: jevCheck, vcc: vccCheck, llmStale: llmStale.stale, resume };
  writeFileSync(out, JSON.stringify(result, null, 1));
  table.push(summarize(slug, result));
}

function summarize(slug: string, r: any): string {
  const score = (v: string[]) => {
    const n = v.length || 1;
    const pts = v.reduce((s, x) => s + (x === "present" ? 1 : x === "partial" ? 0.5 : 0), 0);
    return `${Math.round((pts / n) * 100)}%${v.includes("contradicted") ? ` (${v.filter((x) => x === "contradicted").length}✗)` : ""}`;
  };
  const res = r.resume ? ` | resume llm ${r.resume.llm?.overall} jev ${r.resume.jev?.overall} vcc ${r.resume.vcc?.overall}` : "";
  return `${slug.padEnd(44)} facts jev ${score(r.jev.verdicts)} vcc ${score(r.vcc.verdicts)} | stale llm ${r.llmStale.length} jev ${r.jev.stale.length} vcc ${r.vcc.stale.length}${res}`;
}
console.log(table.join("\n"));
