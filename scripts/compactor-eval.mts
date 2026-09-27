/**
 * Compactor evaluation harness — replays the lossless compactor at real
 * compaction points of recorded Pi sessions and writes, per case, the summary
 * next to what actually happened afterwards, so a reviewer can judge whether
 * the summary was enough to continue (and whether it carries stale noise).
 *
 *   npx tsx scripts/compactor-eval.mts <out-dir> <session.jsonl[:compactionIndex]>...
 *
 * compactionIndex defaults to the last compaction; "all" replays every one.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { planJevCompaction, planLosslessCompaction } from "../packages/compactor/src/compaction/hooks.ts";
import { pruneWithJev } from "../packages/compactor/src/compaction/jev-prune.ts";
import { DEFAULT_COMPACTOR_CONFIG } from "../packages/compactor/src/config/schema.ts";
import { collectOrigins, isInjectedUserText } from "../packages/compactor/src/compaction/source.ts";
import { textOf } from "../packages/compactor/src/compaction/content.ts";

const args = process.argv.slice(2);
const useJev = args[0] === "--jev";
const [outDir, ...specs] = useJev ? args.slice(1) : args;
const JEV = { provider: "openrouter" as const, model: "typesafe/jev-1.13", baseUrl: "", apiKey: "", timeoutMs: 20_000 };
if (!outDir || specs.length === 0) {
  console.error("usage: compactor-eval.mts <out-dir> <session.jsonl[:idx|all]>...");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const flat = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
};

function projectDir(file: string): string | undefined {
  const dir = basename(join(file, ".."));
  const m = dir.match(/^--(.+)--$/);
  return m ? `/${m[1].replace(/-/g, "/")}` : undefined;
}

const rows: string[] = [];
for (const spec of specs) {
  const [file, which] = spec.split(/:(?=[^/]*$)/);
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return []; // truncated line (crash mid-write)
    }
  });
  const header = entries.find((e) => e.type === "session");
  const withId = entries.filter((e) => e.id);
  const byId = new Map(withId.map((e) => [e.id, e]));
  const children = new Map<string, any[]>();
  for (const e of withId) if (e.parentId) children.set(e.parentId, [...(children.get(e.parentId) ?? []), e]);
  const compactions = withId.filter((e) => e.type === "compaction");
  const picks = which === "all" ? compactions.map((_, i) => i) : [which !== undefined ? Number(which) : compactions.length - 1];
  const cwd = header?.cwd ?? projectDir(file);

  for (const idx of picks) {
    const target = compactions[idx];
    if (!target) continue;
    const branch: any[] = [];
    for (let cur = byId.get(target.parentId); cur; cur = byId.get(cur.parentId)) branch.unshift(cur);
    const t0 = performance.now();
    const planInput = { branchEntries: branch, tokensBefore: target.tokensBefore, config: DEFAULT_COMPACTOR_CONFIG, cwd };
    const plan = useJev
      ? await planJevCompaction(planInput, (c, s) => pruneWithJev(c, s, JEV))
      : planLosslessCompaction(planInput);
    const ms = Math.round(performance.now() - t0);
    const slug = `${basename(join(file, "..")).replace(/^--home-oi-Projects-|--$/g, "").slice(0, 40)}-c${idx}`;
    if (!plan.ok) {
      rows.push(`${slug}\tSKIP ${plan.reason}`);
      continue;
    }

    // What happened next: follow the first child chain after the compaction.
    const origins = collectOrigins(branch);
    const after: string[] = [];
    let cur = target;
    for (let n = 0; n < 400 && after.length < 8; n++) {
      const next = children.get(cur.id)?.[0];
      if (!next) break;
      cur = next;
      if (next.type !== "message") continue;
      const m = next.message;
      if (m.role === "user") {
        const t = textOf(m.content);
        after.push(`${isInjectedUserText(t, origins) ? "[injected]" : "[USER]"} ${flat(t, 400)}`);
      } else if (m.role === "assistant") {
        const t = (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
        const tools = (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "toolCall").map((p: any) => `${p.name}(${flat(JSON.stringify(p.arguments ?? {}), 90)})`);
        if (t.trim() || tools.length) after.push(`[assistant] ${flat(t, 300)}${tools.length ? ` {${tools.slice(0, 3).join("; ")}}` : ""}`);
      }
    }
    const keptIdx = branch.findIndex((e) => e.id === plan.firstKeptEntryId);
    const keptUser = keptIdx >= 0
      ? branch.slice(keptIdx).filter((e) => e.type === "message" && e.message.role === "user").map((e) => flat(textOf(e.message.content), 200))
      : [];

    const doc = [
      `# ${slug}`,
      `session: ${file}`,
      `branch entries: ${branch.length} · tokensBefore ${target.tokensBefore} · summary ${plan.summary.length} chars (~${Math.round(plan.summary.length / 4)} tok) · kept tail ~${plan.stats.keptTokensEst} tok · ${ms} ms`,
      `sections: ${(plan.details.sections as string[]).join(", ")}`,
      ...(useJev ? [`jev: ${JSON.stringify(plan.details.jev, null, 1)}`] : []),
      "",
      "## SUMMARY",
      plan.summary,
      "",
      "## KEPT TAIL (user messages)",
      ...keptUser.map((u) => `- ${u}`),
      "",
      "## WHAT HAPPENED NEXT",
      ...after.map((a) => `- ${a}`),
    ].join("\n");
    writeFileSync(join(outDir, `${slug}.md`), doc);
    const jev = plan.details.jev as { asked?: number; dropped?: number } | undefined;
    rows.push(`${slug}\t${plan.summary.length}c\t${ms}ms\t${target.tokensBefore}→${plan.stats.tokensAfterEst}${jev ? `\tjev ${jev.dropped}/${jev.asked}` : ""}`);
  }
}
console.log(rows.join("\n"));
