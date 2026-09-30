/**
 * UNI-11 — jev vs a normal model as skill judge (eval harness).
 *
 * Runs on coffee (catalog, keys and the omniroute bridge live there):
 *   cd ~/Projects/Personal/archived/unipi
 *   export PATH=$HOME/.local/share/mise/installs/node/lts/bin:$PATH
 *   node_modules/.bin/tsx .unipi/skill-eval/run.ts
 *
 * Catalog: ~/skill-eval-mock/.agents/skills (name + description from the
 * SKILL.md frontmatter, via the registry's own listVaultSkills).
 * jev: the repo's real judgeRequest + askJev with coffee's judge settings
 *      (openrouter, typesafe/jev-1.13, OPENROUTER_API_KEY from the env).
 * Model: coffee's omniroute defaultProvider/defaultModel, temperature 0.
 * Ground truth: cases.json (authored, fixed — this script never edits it).
 *
 * Revealed-set variants per case:
 *   jev0.6 / jev0.8 — pins ∪ {score ≥ thr}, capped at 5 by score, pins first
 *                     (the current later-prompt reveal rule at that threshold)
 *   nopins0.6 / nopins0.8 — the same without pins, to separate the two causes
 *   model — the model judge's JSON list (at most 5, its own order)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev } from "@pi-unipi/core";
import { judgeRequest, pinnedSkills, toEntry, type Entry } from "../../packages/skill-registry/src/judge.ts";
import { listVaultSkills } from "../../packages/skill-registry/src/vault.ts";

const REVEAL_CAP = 5;
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = join(homedir(), "skill-eval-mock", ".agents", "skills");

interface Case { id: string; prompt: string; expected: string[]; acceptable: string[] }

const { cases } = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf-8")) as { cases: Case[] };
const entries: Entry[] = listVaultSkills(MOCK).map(toEntry);

const agentSettings = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8")) as {
  defaultProvider?: string;
  defaultModel?: string;
};
const bridge = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "omniroute-bridge", "config.json"), "utf-8")) as {
  baseUrl: string;
  apiKey: string;
};
const MODEL = `${agentSettings.defaultProvider}/${agentSettings.defaultModel}`;

/** Coffee's jev judge settings (settings.json → unipi.longHorizon.judge). */
const jevSettings = (() => {
  const s = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf-8")) as {
    unipi?: { longHorizon?: { judge?: { provider?: string; model?: string; baseUrl?: string; timeoutMs?: number } } };
  };
  const j = s.unipi?.longHorizon?.judge ?? {};
  return { provider: (j.provider ?? "openrouter") as "openrouter", model: j.model ?? "typesafe/jev-1.13", baseUrl: j.baseUrl ?? "", apiKey: "", timeoutMs: j.timeoutMs || 60_000 };
})();

const SYSTEM_TEXT =
  `You choose which agent skills would help an AI coding agent handle the user's request. ` +
  `A skill is a playbook the agent can load. Select a skill only if the request clearly calls for what that skill does. ` +
  `Generic workflow skills (planning, brainstorming, minimalism, reviewing) count only when the request asks for that kind of work. ` +
  `Selecting nothing is normal. ` +
  `Reply with JSON only: {"skills": ["name", ...]} (at most 5, most relevant first).`;

async function askModel(prompt: string): Promise<{ names: string[]; ms: number; failures: number }> {
  const state = `${prompt.slice(0, 4000)}\n[project: skill-eval-mock]`;
  const list = entries.map((e) => `- ${e.name}: ${e.description.slice(0, 300)}`).join("\n");
  const user = `${state}\n\nSkills:\n${list}`;
  const call = async (): Promise<string> => {
    const res = await fetch(`${bridge.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.apiKey}` },
      body: JSON.stringify({
        model: agentSettings.defaultModel,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_TEXT },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  };
  let failures = 0;
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await call();
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = match ? (JSON.parse(match[0]) as { skills?: unknown }) : null;
      if (Array.isArray(parsed?.skills)) {
        return { names: parsed.skills.map(String).slice(0, REVEAL_CAP), ms: Date.now() - t0, failures };
      }
      throw new Error(`no skills array in: ${text.slice(0, 200)}`);
    } catch (err) {
      failures++;
      if (attempt === 1) {
        console.warn(`  model judge failed for prompt: ${(err as Error).message}`);
        return { names: [], ms: Date.now() - t0, failures };
      }
    }
  }
  return { names: [], ms: Date.now() - t0, failures };
}

function revealSet(pins: ReadonlySet<string>, thr: number, scores: ReadonlyMap<string, number>): string[] {
  const out = entries.filter((e) => pins.has(e.name)).map((e) => e.name);
  const rest = entries
    .filter((e) => !pins.has(e.name) && (scores.get(e.name) ?? 0) >= thr)
    .sort((a, b) => (scores.get(b.name) ?? 0) - (scores.get(a.name) ?? 0));
  for (const e of rest) {
    if (out.length >= REVEAL_CAP) break;
    out.push(e.name);
  }
  return out.slice(0, REVEAL_CAP);
}

interface CaseResult {
  id: string;
  pins: string[];
  jevMs: number;
  modelMs: number;
  modelFailures: number;
  revealed: Record<"jev0.6" | "jev0.8" | "nopins0.6" | "nopins0.8" | "model", string[]>;
  scores: Record<string, number>;
}

const perCase: CaseResult[] = [];
for (const c of cases) {
  process.stdout.write(`case ${c.id} … `);
  const req = judgeRequest(entries, c.prompt, "skill-eval-mock");
  const t0 = Date.now();
  const answers = await askJev({ ...req, settings: jevSettings, env: process.env });
  const jevMs = Date.now() - t0;
  if (!answers) console.warn(`jev fail-open (${jevMs}ms)`);
  const scores = new Map<string, number>(entries.map((e, i) => [e.name, typeof answers?.[`s${i}`]?.noul === "number" ? (answers[`s${i}`]!.noul as number) : -1]));
  const pins = pinnedSkills(entries, c.prompt);
  const model = await askModel(c.prompt);
  console.log(`jev ${jevMs}ms · model ${model.ms}ms · pins [${[...pins].join(", ")}] · model picked [${model.names.join(", ")}]`);
  perCase.push({
    id: c.id,
    pins: [...pins],
    jevMs,
    modelMs: model.ms,
    modelFailures: model.failures,
    revealed: {
      "jev0.6": revealSet(pins, 0.6, scores),
      "jev0.8": revealSet(pins, 0.8, scores),
      "nopins0.6": revealSet(new Set(), 0.6, scores),
      "nopins0.8": revealSet(new Set(), 0.8, scores),
      model: model.names,
    },
    scores: Object.fromEntries(scores),
  });
}

const VARIANTS = ["jev0.6", "jev0.8", "nopins0.6", "nopins0.8", "model"] as const;
function score(revealed: string[], c: Case): { tp: number; fp: number; fn: number } {
  const r = new Set(revealed);
  const exp = new Set(c.expected);
  const acc = new Set(c.acceptable);
  let tp = 0;
  let fp = 0;
  for (const n of r) if (exp.has(n)) tp++;
  else if (!acc.has(n)) fp++;
  return { tp, fp, fn: c.expected.filter((n) => !r.has(n)).length };
}
const totals = Object.fromEntries(
  VARIANTS.map((v) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let cleanEmpties = 0;
    const empties = cases.filter((c) => c.expected.length === 0);
    for (const c of cases) {
      const s = score(perCase.find((p) => p.id === c.id)!.revealed[v], c);
      tp += s.tp;
      fp += s.fp;
      fn += s.fn;
    }
    for (const c of empties) if (score(perCase.find((p) => p.id === c.id)!.revealed[v], c).fp === 0) cleanEmpties++;
    return [v, { tp, fp, fn, precision: +(tp / (tp + fp)).toFixed(3), recall: +(tp / (tp + fn)).toFixed(3), cleanEmpties, ofEmpties: empties.length }];
  }),
);

const results = {
  meta: {
    date: new Date().toISOString(),
    catalogSize: entries.length,
    catalog: entries.map((e) => ({ name: e.name, description: e.description })),
    jev: jevSettings,
    model: MODEL,
    revealCap: REVEAL_CAP,
    note: "revealed sets over the mock catalog; jev scores from one full-catalog call per case",
  },
  perCase,
  totals,
};
writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));

// Markdown per-case table (report.md wraps it).
const md = [
  "| case | expected | jev0.6 | jev0.8 | model | pins |",
  "|------|----------|--------|--------|-------|------|",
  ...cases.map((c) => {
    const r = perCase.find((p) => p.id === c.id)!;
    const cell = (names: string[]) => (names.length ? names.join(", ") : "—");
    return `| ${c.id} | ${cell(c.expected)} | ${cell(r.revealed["jev0.6"])} | ${cell(r.revealed["jev0.8"])} | ${cell(r.revealed.model)} | ${cell(r.pins)} |`;
  }),
].join("\n");
writeFileSync(join(HERE, "per-case-table.md"), md);

console.log(`\ncatalog: ${entries.length} skills · jev ${jevSettings.provider}/${jevSettings.model} · model ${MODEL}`);
for (const v of VARIANTS) {
  const t = totals[v] as { tp: number; fp: number; fn: number; precision: number; recall: number; cleanEmpties: number; ofEmpties: number };
  console.log(`${v.padEnd(9)} P=${t.precision} R=${t.recall} tp=${t.tp} fp=${t.fp} fn=${t.fn} cleanEmpties=${t.cleanEmpties}/${t.ofEmpties}`);
}
console.log(`\nwrote ${join(HERE, "results.json")}`);
