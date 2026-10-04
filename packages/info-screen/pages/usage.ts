/**
 * Usage — spend over time across every session on this machine.
 *
 *   today / week / month / all-time  (big gradient numbers)
 *   30-day column chart with weekday axis + peak marker
 *   model share bar + ranked models (cost and tokens)
 */

import { columns, compact, CRAB, fitTo, money, rightTo, shareBar, type RGB } from "@pi-unipi/core";
import type { GroupData, PageContext } from "../types.js";
import type { UsageStats } from "../usage-parser.js";
import { dim, empty, legend, muted, section, tag, tiles } from "../tui/page-kit.js";

export interface UsageRaw {
  tokens: UsageStats["tokens"];
  cost: UsageStats["cost"];
  costWeek: number;
  costMonth: number;
  sessions: number;
  sessionsToday: number;
  daily: UsageStats["daily"];
  models: Array<[string, number, number]>; // name, cost, tokens (this month)
  compaction?: UsageStats["compaction"];
  compactionByDir?: UsageStats["compactionByDir"];
}

const sumCost = (b: UsageStats["byModelWeek"]): number => Object.values(b).reduce((s, m) => s + m.cost, 0);

export function usageData(stats: UsageStats): GroupData {
  const models = Object.entries(stats.byModelMonth)
    .map(([n, m]) => [n.replace(/^Claude /, ""), m.cost, m.tokens] as [string, number, number])
    .sort((a, b) => b[1] - a[1] || b[2] - a[2])
    .slice(0, 8);
  const raw: UsageRaw = {
    tokens: stats.tokens,
    cost: stats.cost,
    costWeek: sumCost(stats.byModelWeek),
    costMonth: sumCost(stats.byModelMonth),
    sessions: stats.sessionCount,
    sessionsToday: stats.sessionsToday,
    daily: stats.daily,
    models,
    compaction: stats.compaction,
    compactionByDir: stats.compactionByDir,
  };
  return {
    tokensToday: { value: compact(stats.tokens.today) },
    costToday: { value: money(stats.cost.today) },
    costAllTime: { value: money(stats.cost.allTime) },
    sessions: { value: String(stats.sessionCount) },
    raw: { value: "", raw },
  };
}

const MODEL_COLORS: RGB[] = [CRAB.orange, [0, 200, 240], [190, 150, 240], [120, 200, 120], CRAB.gold, [230, 120, 200], [78, 201, 176], [140, 140, 160]];

export function renderUsage(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as UsageRaw | undefined;
  if (!raw) return empty(pc, "No usage yet", "pi has no session history on this machine");
  const p = pc.paint;
  const out: string[] = [];
  const useCost = raw.cost.allTime > 0;

  const big = (n: number): string => (n >= 100 ? `$${n >= 1000 ? compact(n) : Math.round(n)}` : money(n));
  out.push(section(pc, "spend", `${tag(p, "g")} ${dim(p, "all time")} ${p.bold(p.rgb(CRAB.gold, money(raw.cost.allTime)))} ${dim(p, `· ${raw.sessions} sessions, every project`)}`));
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  out.push(
    ...tiles(pc, useCost
      ? [
          { scope: "g", label: "today", value: big(raw.cost.today), sub: `${compact(raw.tokens.today)} tok · ${plural(raw.sessionsToday, "session")}`, stops: [CRAB.gold, CRAB.orange, CRAB.red] },
          { scope: "g", label: "this week", value: big(raw.costWeek), sub: `${compact(raw.tokens.week)} tokens` },
          { scope: "g", label: "this month", value: big(raw.costMonth), sub: `${compact(raw.tokens.month)} tokens` },
        ]
      : [
          { scope: "g", label: "today", value: compact(raw.tokens.today), sub: "tokens" },
          { scope: "g", label: "week", value: compact(raw.tokens.week), sub: "tokens" },
          { scope: "g", label: "month", value: compact(raw.tokens.month), sub: "tokens" },
        ]),
  );

  // 30-day chart: day columns with gutters, value labels over the peak and
  // today, and a date axis (day-of-month every Monday).
  out.push("");
  const series = raw.daily.map((d) => (useCost ? d.cost : d.tokens));
  const n = series.length;
  const max = Math.max(0, ...series);
  const fmt = (v: number): string => (useCost ? money(v) : compact(v));
  const days30 = series.reduce((a, b) => a + b, 0);
  out.push(section(pc, "last 30 days", dim(p, `${fmt(days30)} total · ${fmt(days30 / n)}/day avg`), "g"));
  const chartW = pc.width;
  const dayOf = (c: number): number => Math.min(n - 1, Math.floor((c * n) / chartW));
  const firstCell = (d: number): number => Math.ceil((d * chartW) / n);
  const gutter = chartW / n >= 3;
  const cells: number[] = [];
  for (let c = 0; c < chartW; c++) {
    const d = dayOf(c);
    const lastCell = c + 1 >= chartW || dayOf(c + 1) !== d;
    cells.push(gutter && lastCell ? 0 : series[d]!);
  }
  const H = 5;
  const chart = columns(p, cells, chartW, H, [[110, 80, 40], CRAB.orange, CRAB.gold]);
  // Callouts: peak and today, placed on the row above their bar's top.
  const peakIdx = series.indexOf(max);
  const callouts: Array<{ day: number; text: string; color: RGB }> = [];
  if (max > 0) callouts.push({ day: peakIdx, text: `▾${fmt(max)}`, color: CRAB.gold });
  if (peakIdx !== n - 1 && series[n - 1]! > 0) callouts.push({ day: n - 1, text: `▾${fmt(series[n - 1]!)}`, color: [240, 240, 168] });
  let calloutRow = " ".repeat(chartW);
  const plainAt = (row: string, at: number, text: string): string => row.slice(0, at) + text + row.slice(at + text.length);
  const placed: Array<{ at: number; text: string; color: RGB }> = [];
  for (const c of callouts) {
    const at = Math.max(0, Math.min(chartW - c.text.length, firstCell(c.day)));
    if (placed.some((q) => at < q.at + q.text.length + 1 && q.at < at + c.text.length + 1)) continue;
    placed.push({ at, text: c.text, color: c.color });
    calloutRow = plainAt(calloutRow, at, c.text);
  }
  // Paint the callout row.
  let painted = "";
  let cur = 0;
  for (const q of [...placed].sort((a, b) => a.at - b.at)) {
    painted += " ".repeat(q.at - cur) + p.bold(p.rgb(q.color, q.text));
    cur = q.at + q.text.length;
  }
  out.push(fitTo(painted, pc.width));
  out.push(...chart.map((l) => fitTo(l, pc.width)));
  // Date axis: day number under each Monday, "today" under the last bar.
  let axis = "";
  let col = 0;
  const marks: Array<{ at: number; text: string; color?: RGB }> = [];
  for (let d = 0; d < n; d++) {
    const date = new Date(Date.now() - (n - 1 - d) * 86_400_000);
    if (d === n - 1) marks.push({ at: Math.max(0, Math.min(chartW - 5, firstCell(d))), text: "today", color: [240, 240, 168] });
    else if (date.getDay() === 1) marks.push({ at: firstCell(d), text: `${date.toLocaleString("en", { month: "short" })} ${date.getDate()}` });
  }
  for (const m of marks) {
    if (m.at < col) continue;
    axis += " ".repeat(m.at - col) + (m.color ? p.rgb(m.color, m.text) : dim(p, m.text));
    col = m.at + m.text.length;
  }
  out.push(fitTo(axis, pc.width));

  // Models.
  if (raw.models.length > 0) {
    out.push("");
    const metric = (m: [string, number, number]): number => (useCost ? m[1] : m[2]);
    const total = raw.models.reduce((s, m) => s + metric(m), 0) || 1;
    out.push(section(pc, "models this month", dim(p, plural(raw.models.length, "model")), "g"));
    if (raw.models.length === 1) {
      // One model: a single line says it all.
      const m = raw.models[0]!;
      out.push(fitTo(`${p.rgb(MODEL_COLORS[0]!, "●")} ${p.bold(m[0])}  ${dim(p, "every token this month")}  ${p.bold(useCost ? money(m[1]) : compact(m[2]))}`, pc.width));
    } else {
      out.push(fitTo(shareBar(p, raw.models.map((m, i) => ({ value: metric(m), color: MODEL_COLORS[i % MODEL_COLORS.length]! })), pc.width, "▆"), pc.width));
      out.push("");
      // Ranked list: bars scaled to the TOTAL (so they read as shares, not "max = full").
      const nameW = Math.min(26, Math.max(...raw.models.map((m) => m[0].length)) + 1);
      const valW = 14;
      const barW = Math.max(6, pc.width - nameW - valW - 5);
      raw.models.slice(0, 6).forEach((m, i) => {
        const c = MODEL_COLORS[i % MODEL_COLORS.length]!;
        const share = metric(m) / total;
        const units = Math.round(share * barW * 8);
        const bar = p.rgb(c, "█".repeat(Math.floor(units / 8)) + (["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][units % 8] ?? ""));
        const val = `${p.bold(useCost ? money(m[1]) : compact(m[2]))} ${muted(p, `${Math.round(share * 100)}%`.padStart(4))}`;
        out.push(fitTo(`${p.rgb(c, "●")} ${fitTo(m[0], nameW)} ${fitTo(bar, barW)} ${rightTo(val, valW)}`, pc.width));
      });
      if (raw.models.length > 6) out.push(...legend(pc, [{ label: `${raw.models.length - 6} more models`, color: [140, 140, 160] }]));
    }
  }
  return out;
}
