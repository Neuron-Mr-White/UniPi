/**
 * Continuation A/B for the compactor: at a real compaction point of a
 * recorded session, write two resumable session files —
 *   <slug>.old.jsonl  the branch + the compaction that actually happened
 *   <slug>.new.jsonl  the branch + today's compactor summary (vcc or jev)
 * plus <slug>.next.md with what really happened afterwards. Fork each file
 * with `pi --fork <file> -nt -p "<question>"` and compare the answers
 * against .next.md.
 *
 *   npx tsx scripts/compactor-continue.mts [--jev] <out-dir> <session.jsonl[:idx]>...
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { planJevCompaction, planLosslessCompaction } from "../packages/compactor/src/compaction/hooks.ts";
import { pruneWithJev } from "../packages/compactor/src/compaction/jev-prune.ts";
import { DEFAULT_COMPACTOR_CONFIG } from "../packages/compactor/src/config/schema.ts";
import { textOf } from "../packages/compactor/src/compaction/content.ts";
import { collectOrigins, isInjectedUserText } from "../packages/compactor/src/compaction/source.ts";

const args = process.argv.slice(2);
const useJev = args[0] === "--jev";
const [outDir, ...specs] = useJev ? args.slice(1) : args;
const JEV = { provider: "openrouter" as const, model: "typesafe/jev-1.13", baseUrl: "", apiKey: "", timeoutMs: 20_000 };
mkdirSync(outDir, { recursive: true });

const flat = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

for (const spec of specs) {
  const [file, which] = spec.split(/:(?=[^/]*$)/);
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
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
  const target = compactions[which !== undefined ? Number(which) : compactions.length - 1];
  if (!target) continue;
  const branch: any[] = [];
  for (let cur = byId.get(target.parentId); cur; cur = byId.get(cur.parentId)) branch.unshift(cur);
  const input = { branchEntries: branch, tokensBefore: target.tokensBefore, config: DEFAULT_COMPACTOR_CONFIG, cwd: header?.cwd };
  const plan = useJev ? await planJevCompaction(input, (c, s) => pruneWithJev(c, s, JEV)) : planLosslessCompaction(input);
  if (!plan.ok) continue;
  const slug = basename(join(file, "..")).replace(/^--home-oi-Projects-|--$/g, "").slice(0, 40) + `-c${compactions.indexOf(target)}`;

  const head = { ...header, id: randomUUID(), timestamp: new Date().toISOString() };
  const lines = (compaction: any) => [head, ...branch, compaction].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(outDir, `${slug}.old.jsonl`), lines(target));
  writeFileSync(
    join(outDir, `${slug}.new.jsonl`),
    lines({
      ...target,
      id: randomUUID().slice(0, 8),
      summary: plan.summary,
      firstKeptEntryId: plan.firstKeptEntryId,
      details: plan.details,
      fromHook: true,
    }),
  );

  // What really happened next (first child chain after the compaction).
  const origins = collectOrigins(branch);
  const next: string[] = [];
  let cur = target;
  for (let n = 0; n < 600 && next.length < 14; n++) {
    const child = children.get(cur.id)?.[0];
    if (!child) break;
    cur = child;
    if (child.type !== "message") continue;
    const m = child.message;
    if (m.role === "user") {
      const t = textOf(m.content);
      next.push(`${isInjectedUserText(t, origins) ? "[injected]" : "[USER]"} ${flat(t, 500)}`);
    } else if (m.role === "assistant") {
      const text = (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
      const tools = (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "toolCall").map((p: any) => `${p.name}(${flat(JSON.stringify(p.arguments ?? {}), 120)})`);
      if (text.trim() || tools.length) next.push(`[assistant] ${flat(text, 400)}${tools.length ? ` {${tools.slice(0, 3).join("; ")}}` : ""}`);
    }
  }
  writeFileSync(
    join(outDir, `${slug}.next.md`),
    [`# ${slug}`, `old summary: ${target.summary.length} chars (${target.details?.compactor ?? "pi"}), new: ${plan.summary.length} chars`, "", "## What happened next", ...next.map((l) => `- ${l}`)].join("\n"),
  );
  console.log(`${slug}\told ${target.summary.length}c\tnew ${plan.summary.length}c`);
}
