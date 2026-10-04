/**
 * What fills the context window right now.
 *
 * Categories are sized by characters (≈4 chars/token) from what pi will send
 * next — system prompt, tool schemas, and the compaction-aware message
 * projection — then scaled so they sum to pi's own token count when it has
 * one. Estimates, but the proportions are what matter.
 */

import { CRAB, fitTo, compact, type RGB, type Paint } from "@pi-unipi/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { PageContext } from "../types.js";
import { dim, muted, section } from "../tui/page-kit.js";

export type ContextPart = "system" | "tools" | "user" | "assistant" | "results" | "summary" | "other";

export interface ContextBreakdown {
  parts: Record<ContextPart, number>;
  /** Biggest tool results still in context: [tool, tokens]. */
  heavy: Array<[string, number]>;
  /** Tokens (pi's real count when known). */
  used: number;
  window: number;
  estimated: boolean;
}

export const PARTS: ReadonlyArray<{ id: ContextPart; label: string; glyph: string; color: RGB }> = [
  { id: "system", label: "system prompt", glyph: "◆", color: [190, 150, 240] },
  { id: "tools", label: "tool schemas", glyph: "≡", color: [110, 150, 255] },
  { id: "summary", label: "summaries", glyph: "§", color: [78, 201, 176] },
  { id: "user", label: "your prompts", glyph: "❯", color: [0, 200, 240] },
  { id: "assistant", label: "replies", glyph: "◇", color: CRAB.orange },
  { id: "results", label: "tool results", glyph: "▪", color: CRAB.gold },
  { id: "other", label: "other", glyph: "·", color: [140, 140, 150] },
];

const CHARS_PER_TOKEN = 4;

function textLen(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const b = c as { type?: string; text?: string; thinking?: string; arguments?: unknown; data?: string };
    if (b.type === "text") n += b.text?.length ?? 0;
    else if (b.type === "thinking") n += b.thinking?.length ?? 0;
    else if (b.type === "toolCall") n += JSON.stringify(b.arguments ?? {}).length + 32;
    else if (b.type === "image") n += 1600 * CHARS_PER_TOKEN; // ~1.6k tokens per image
  }
  return n;
}

export interface ContextSource {
  systemPrompt?: string;
  toolSchemas?: number;
  messages: readonly unknown[];
  used: number | null;
  window: number;
}

export function contextBreakdown(src: ContextSource): ContextBreakdown {
  const chars: Record<ContextPart, number> = { system: 0, tools: 0, user: 0, assistant: 0, results: 0, summary: 0, other: 0 };
  chars.system = src.systemPrompt?.length ?? 0;
  chars.tools = src.toolSchemas ?? 0;
  const heavy = new Map<string, number>();
  for (const raw of src.messages) {
    const m = raw as { role?: string; content?: unknown; summary?: string; toolName?: string; command?: string; output?: string };
    switch (m?.role) {
      case "user":
        chars.user += textLen(m.content);
        break;
      case "assistant":
        chars.assistant += textLen(m.content);
        break;
      case "toolResult": {
        const n = textLen(m.content);
        chars.results += n;
        const name = m.toolName ?? "tool";
        heavy.set(name, (heavy.get(name) ?? 0) + n);
        break;
      }
      case "bashExecution":
        chars.results += (m.command?.length ?? 0) + (m.output?.length ?? 0);
        heavy.set("bash (!)", (heavy.get("bash (!)") ?? 0) + (m.output?.length ?? 0));
        break;
      case "compactionSummary":
      case "branchSummary":
        chars.summary += m.summary?.length ?? 0;
        break;
      case "custom":
        chars.other += textLen(m.content);
        break;
      default:
        break;
    }
  }
  const estTotal = Object.values(chars).reduce((a, b) => a + b, 0) / CHARS_PER_TOKEN;
  // Before the first reply pi reports 0 (or null): fall back to the estimate
  // so the system prompt and tool schemas still show.
  const known = src.used !== null && src.used > 0;
  const used = known ? src.used! : estTotal;
  const k = estTotal > 0 ? used / estTotal : 0;
  const parts = Object.fromEntries(Object.entries(chars).map(([id, c]) => [id, (c / CHARS_PER_TOKEN) * k])) as Record<ContextPart, number>;
  const heavyTok = [...heavy.entries()].map(([n, c]) => [n, (c / CHARS_PER_TOKEN) * k] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return { parts, heavy: heavyTok, used, window: src.window, estimated: !known };
}

/** Distribute `cells` among parts by size, ≥1 cell for any non-zero part. */
function apportion(sizes: readonly number[], cells: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0 || cells <= 0) return sizes.map(() => 0);
  const raw = sizes.map((s) => (s / total) * cells);
  const out = raw.map((r, i) => (sizes[i]! > 0 ? Math.max(1, Math.floor(r)) : 0));
  let sum = out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let j = 0; sum < cells && j < order.length * 4; j++) {
    const i = order[j % order.length]![1];
    if (sizes[i]! > 0) {
      out[i]!++;
      sum++;
    }
  }
  while (sum > cells) {
    const i = out.indexOf(Math.max(...out));
    out[i]!--;
    sum--;
  }
  return out;
}

/**
 * The bucket: a box whose inside is the context's composition at full width
 * (each category a coloured block with its glyph and name printed on it when
 * it fits), and whose bottom edge is the window gauge — solid up to the fill
 * level in a pressure colour, dotted for the free space.
 *
 *   ╭──────────────────────────────────────────────╮
 *   │◆ sys│⚙│❯ you│◇ replies    │▤ tool results     │
 *   │▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│
 *   ╰━━━━━━━━━━━━━━━━┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯ 34%
 */
function tank(p: Paint, b: ContextBreakdown, width: number, fillColor: RGB): string[] {
  const inner = Math.max(6, width - 2);
  const sizes = PARTS.map((x) => b.parts[x.id]);
  const cells = apportion(sizes, inner);
  const ink: RGB = [16, 16, 22];
  let label = "";
  let shade = "";
  PARTS.forEach((x, i) => {
    const n = cells[i]!;
    if (n <= 0) return;
    const full = ` ${x.glyph} ${x.label} `;
    const short = ` ${x.glyph} `;
    const text = n >= visibleWidth(full) ? full : n >= visibleWidth(short) ? short : "";
    label += p.on(ink, x.color, p.bold(text) + " ".repeat(n - visibleWidth(text)));
    shade += p.rgb(x.color, "▀".repeat(n));
  });
  const edge = (s: string): string => p.fg("borderMuted", s);
  const fill = b.window > 0 ? Math.min(inner, Math.round((b.used / b.window) * inner)) : 0;
  const gaugeEdge = p.rgb(fillColor, "━".repeat(fill)) + p.fg("borderMuted", "┄".repeat(inner - fill));
  return [
    edge(`╭${"─".repeat(inner)}╮`),
    `${edge("│")}${label}${edge("│")}`,
    `${edge("│")}${shade}${edge("│")}`,
    `${edge("╰")}${gaugeEdge}${edge("╯")}`,
  ];
}

/** Pct of window → colour (calm until 70%, then warm, red past 90%). */
function pressure(pct: number): RGB {
  return pct > 90 ? [230, 90, 80] : pct > 70 ? [240, 190, 60] : [120, 200, 120];
}

export function renderContext(pc: PageContext, b: ContextBreakdown): string[] {
  const p = pc.paint;
  const out: string[] = [];
  const pct = b.window > 0 ? (b.used / b.window) * 100 : 0;
  const right = b.window > 0
    ? `${p.bold(p.rgb(pressure(pct), `${compact(b.used)}`))} ${dim(p, `of ${compact(b.window)} ·`)} ${p.rgb(pressure(pct), `${pct.toFixed(0)}% full`)}${b.estimated ? dim(p, " ~") : ""}`
    : dim(p, "no model");
  out.push(section(pc, "context", right, "s"));
  out.push(...tank(p, b, pc.width, pressure(pct)).map((l) => fitTo(l, pc.width)));

  // Legend as a 2-column table: glyph label ····· tokens  share-pie
  const rows = PARTS.filter((x) => b.parts[x.id] >= 1).map((x) => {
    const t = b.parts[x.id];
    const share = b.used > 0 ? t / b.used : 0;
    return { x, t, share };
  });
  const colW = pc.width >= 72 ? Math.floor((pc.width - 4) / 2) : pc.width;
  const cell = (r: (typeof rows)[number]): string => {
    const head = `${p.rgb(r.x.color, r.x.glyph)} ${muted(p, r.x.label)}`;
    const val = `${p.bold(compact(r.t))} ${dim(p, `${Math.round(r.share * 100)}%`.padStart(4))}`;
    const gap = colW - visibleWidth(head) - visibleWidth(val) - 2;
    return fitTo(`${head} ${p.fg("borderMuted", "·".repeat(Math.max(1, gap)))} ${val}`, colW);
  };
  if (colW < pc.width) {
    const half = Math.ceil(rows.length / 2);
    for (let i = 0; i < half; i++) out.push(fitTo(`${cell(rows[i]!)}    ${rows[i + half] ? cell(rows[i + half]!) : ""}`, pc.width));
  } else {
    for (const r of rows) out.push(cell(r));
  }

  // Heaviest tool output still in context.
  if (b.heavy.length > 0 && b.heavy[0]![1] >= 500) {
    const items = b.heavy.map(([n, t]) => `${p.rgb(CRAB.gold, "▪")} ${n} ${p.bold(compact(t))}`);
    out.push(fitTo(`${dim(p, "heaviest:")} ${items.join(dim(p, "  ·  "))}`, pc.width));
  }
  return out;
}
