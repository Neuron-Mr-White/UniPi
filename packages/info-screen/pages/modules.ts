/**
 * Module pages — renderers for pages that unipi module packages register.
 *
 * Module packages only depend on @pi-unipi/core, so they ship data (a
 * structured `raw` stat) and the info screen owns the drawing, keyed by page
 * id. A page without `raw` (older module build) falls back to the generic
 * key/value view.
 */

import { compact, CRAB, fitTo, gauge, rightTo, shareBar, type RGB } from "@pi-unipi/core";
import type { PageContext } from "../types.js";
import { dim, dot, empty, healthColor, kv, kvColumns, legend, muted, section, tag, tiles, type Health } from "../tui/page-kit.js";

const ago = (ms: number): string => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const on = (pc: PageContext, v: boolean, yes = "on", no = "off"): string =>
  v ? pc.paint.rgb(healthColor("ok"), `● ${yes}`) : pc.paint.rgb(healthColor("off"), `○ ${no}`);

// ─── MCP ────────────────────────────────────────────────────────────────────

interface McpRaw {
  servers: Array<{ name: string; status: string; tools: number; error?: string; startedAt?: string; scope?: string }>;
}

export function renderMcp(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as McpRaw | undefined;
  if (!raw) return [];
  if (raw.servers.length === 0) return empty(pc, "No MCP servers", "add one in /unipi:settings → MCP");
  const p = pc.paint;
  const health = (s: string): Health => (s === "running" ? "ok" : s === "starting" ? "warn" : s === "error" ? "bad" : "off");
  const running = raw.servers.filter((s) => s.status === "running").length;
  const failed = raw.servers.filter((s) => s.status === "error").length;
  const tools = raw.servers.reduce((a, s) => a + s.tools, 0);
  const out: string[] = [];
  out.push(
    ...tiles(pc, [
      { label: "servers", value: String(raw.servers.length), sub: `${running} running` },
      { label: "tools", value: String(tools), sub: "bridged into pi" },
      { label: "failed", value: String(failed), sub: failed ? "see below" : "all healthy", stops: failed ? [[230, 90, 80], [240, 140, 120]] : [[120, 200, 120], [160, 220, 160]] },
    ]),
  );
  out.push("");
  out.push(section(pc, "servers", `${tag(p, "g")} ${dim(p, "~/.unipi")}  ${tag(p, "p")} ${dim(p, ".unipi in project")}`));
  const maxTools = Math.max(1, ...raw.servers.map((s) => s.tools));
  const nameW = Math.min(26, Math.max(...raw.servers.map((s) => s.name.length)) + 2);
  for (const s of raw.servers) {
    const h = health(s.status);
    const status = p.rgb(healthColor(h), s.status.padEnd(9));
    const barW = Math.max(6, Math.min(30, pc.width - nameW - 24));
    const bar = s.tools > 0 ? gauge(p, s.tools / maxTools, barW, [pc.accent, [180, 240, 180]], " ") : " ".repeat(barW);
    const sc = s.scope === "global" || !s.scope ? tag(p, "g") : tag(p, "p");
    const override = s.scope === "project-override" ? dim(p, " overrides g") : "";
    out.push(fitTo(`${dot(p, h)} ${sc} ${fitTo(p.bold(s.name), nameW)}${status} ${bar} ${rightTo(String(s.tools), 4)}${override}`, pc.width));
    if (s.error) out.push(fitTo(`    ${p.rgb(healthColor("bad"), "└")} ${dim(p, s.error.replace(/\s+/g, " "))}`, pc.width));
  }
  return out;
}

// ─── Compactor ──────────────────────────────────────────────────────────────

interface SavingsLike {
  count: number;
  saved: number;
  avoided: number;
  dollars: number;
  sent: number;
}

interface CompactorRaw {
  method: string;
  trigger: string;
  piCompact: string;
  history: Array<{ before: number; after: number; method: string; at?: number }>;
  before: number;
  after: number;
  saved: number;
  session?: SavingsLike;
  items?: Array<{ at: number; before: number; after: number; replies: number; paid: number; context: number }>;
}

/** Project + global savings come from the usage page (parsed history). */
export interface CompactorHistory {
  project: SavingsLike | null;
  global: SavingsLike | null;
}
let historySource: () => CompactorHistory = () => ({ project: null, global: null });
export function setCompactorHistorySource(fn: () => CompactorHistory): void {
  historySource = fn;
}

const moneyShort = (n: number): string => (n >= 1000 ? `$${compact(n)}` : n >= 100 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0");

export function renderCompactor(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as CompactorRaw | undefined;
  if (!raw) return [];
  const p = pc.paint;
  const out: string[] = [];
  const hist = historySource();
  const sess: SavingsLike = raw.session ?? { count: raw.history.length, saved: raw.saved, avoided: 0, dollars: 0, sent: 0 };

  // Headline: money + tokens not re-sent, per scope.
  const best = hist.global ?? hist.project ?? sess;
  out.push(section(pc, "saved by compaction", dim(p, "tokens not re-sent · ≈ money not spent")));
  out.push(
    ...tiles(pc, [
      { label: "session", value: moneyShort(sess.dollars), sub: `${compact(sess.avoided)} tok · ${sess.count}×`, scope: "s", stops: [[0, 160, 200], [0, 200, 240], [160, 230, 255]] },
      ...(hist.project ? [{ label: "project", value: moneyShort(hist.project.dollars), sub: `${compact(hist.project.avoided)} tok · ${hist.project.count}×`, scope: "p" as const, stops: [[70, 150, 70], [120, 200, 120], [190, 240, 190]] as RGB[] }] : []),
      ...(hist.global ? [{ label: "global", value: moneyShort(hist.global.dollars), sub: `${compact(hist.global.avoided)} tok · ${hist.global.count}×`, scope: "g" as const, stops: [CRAB.amber, CRAB.gold, CRAB.cream] }] : []),
    ]),
  );

  // Without vs with — the gap is the saving.
  if (best.avoided > 0) {
    out.push("");
    const sc: "s" | "p" | "g" = best === hist.global ? "g" : best === hist.project ? "p" : "s";
    out.push(section(pc, "context sent", dim(p, `${Math.round((best.avoided / (best.sent + best.avoided)) * 100)}% less`), sc));
    const without = best.sent + best.avoided;
    const labelW = 9;
    const valW = 7;
    const barW = Math.max(8, pc.width - labelW - valW - 2);
    const withW = Math.max(1, Math.round((best.sent / without) * barW));
    out.push(fitTo(`${fitTo(muted(p, "without"), labelW)}${p.rgb([150, 70, 60], "█".repeat(barW))} ${rightTo(compact(without), valW - 1)}`, pc.width));
    out.push(
      fitTo(
        `${fitTo(muted(p, "with"), labelW)}${p.rgb(pc.accent, "█".repeat(withW))}${p.rgb([90, 70, 60], "░".repeat(barW - withW))} ${rightTo(p.bold(compact(best.sent)), valW - 1)}`,
        pc.width,
      ),
    );
  }

  // Session timeline: each compaction as a drop, ▼ size scaled.
  const items = raw.items ?? [];
  out.push("");
  out.push(section(pc, "this session", dim(p, "before → after · replies since"), "s"));
  if (items.length === 0) {
    out.push(fitTo(dim(p, "  No compaction yet — the context has stayed small."), pc.width));
  } else {
    const max = Math.max(1, ...items.map((h) => h.before));
    const labelW = 20;
    const tailW = 16;
    const barW = Math.max(8, pc.width - labelW - tailW - 2);
    items.slice(-6).forEach((h, i) => {
      const after = h.after || h.before;
      const keep = Math.max(1, Math.round((after / max) * barW));
      const was = Math.max(keep, Math.round((h.before / max) * barW));
      const bar = p.rgb(pc.accent, "█".repeat(keep)) + p.rgb([150, 70, 60], "▒".repeat(was - keep));
      const n = items.length - Math.min(6, items.length) + i + 1;
      const label = `${dim(p, `#${n}`.padEnd(4))}${compact(h.before)} ${dim(p, "→")} ${p.bold(compact(after))}`;
      const saved = h.context > 0 ? (Math.max(0, h.before - after) * h.replies * h.paid) / h.context : 0;
      const tail = `${dim(p, `×${h.replies}`)} ${p.rgb(CRAB.gold, moneyShort(saved))}`;
      out.push(fitTo(`${fitTo(label, labelW)}${fitTo(bar, barW)}  ${rightTo(tail, tailW)}`, pc.width));
    });
    out.push(...legend(pc, [{ label: "kept", color: pc.accent }, { label: "compacted away", color: [150, 70, 60] }, { label: "×replies that skipped it", color: [110, 110, 120] }]));
  }

  out.push("");
  out.push(section(pc, "settings"));
  const last = items.length ? ago(items[items.length - 1]!.at) : raw.history.length ? ago(raw.history[raw.history.length - 1]!.at ?? 0) : "—";
  out.push(...kvColumns(pc, [["method", p.bold(raw.method)], ["runs", raw.trigger], ["pi's /compact", raw.piCompact], ["last", last]]));
  return out;
}

// ─── Updater ────────────────────────────────────────────────────────────────

interface UpdaterRaw {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: number;
  mode?: string;
}

export function renderUpdater(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as UpdaterRaw | undefined;
  if (!raw) return [];
  const p = pc.paint;
  const out: string[] = [];
  const short = (v: string): string => (/alpha\.(\d+)/.exec(v) ? `α${/alpha\.(\d+)/.exec(v)![1]}` : v);
  const state: Health = raw.latest === null ? "warn" : raw.available ? "warn" : "ok";
  out.push(
    ...tiles(pc, [
      { label: "installed", value: short(raw.current).replace("α", ""), sub: `v${raw.current}`, stops: [[120, 160, 255], [190, 150, 240]] },
      { label: "latest", value: raw.latest ? short(raw.latest).replace("α", "") : "-", sub: raw.latest ? `v${raw.latest}` : "checking…", stops: raw.available ? [CRAB.gold, CRAB.orange] : [[120, 200, 120], [160, 220, 160]] },
    ]),
  );
  out.push("");
  const arrowW = Math.max(10, pc.width - 30);
  const track = raw.available
    ? `${p.rgb([120, 160, 255], "●")}${p.rgb(CRAB.orange, "━".repeat(arrowW))}${p.rgb(CRAB.gold, "▶")}`
    : `${p.rgb([120, 200, 120], "●")}${p.fg("borderMuted", "┄".repeat(arrowW))}${p.rgb([120, 200, 120], "●")}`;
  out.push(fitTo(`  ${track}  ${dot(p, state)} ${raw.latest === null ? "checking" : raw.available ? p.bold(p.rgb(CRAB.gold, "update ready")) : p.rgb([120, 200, 120], "up to date")}`, pc.width));
  out.push("");
  out.push(section(pc, "details"));
  out.push(...kvColumns(pc, [["last check", ago(raw.checkedAt)], ["auto update", raw.mode ?? "—"], ["update", raw.available ? "/unipi:update" : "—"], ["changelog", "/unipi:changelog"]]));
  return out;
}

// ─── Web API ────────────────────────────────────────────────────────────────

interface WebRaw {
  providers: Array<{ id: string; name: string; caps: string[]; enabled: boolean; keyed: boolean; hasKey: boolean }>;
  tools: Record<string, boolean>;
  smartFetch: string[] | null;
  wigolo: string;
  cache: { entries: number; bytes: number; expired: number };
}

export function renderWeb(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as WebRaw | undefined;
  if (!raw) return [];
  const p = pc.paint;
  const out: string[] = [];
  const usable = raw.providers.filter((x) => x.enabled && x.hasKey).length;
  out.push(
    ...tiles(pc, [
      { label: "providers", value: `${usable}`, sub: `of ${raw.providers.length} usable` },
      { label: "cache", value: compact(raw.cache.entries), sub: `${(raw.cache.bytes / 1024 / 1024).toFixed(1)} MB · ${raw.cache.expired} expired` },
    ]),
  );
  out.push("");
  // Tools strip.
  const toolChips = Object.entries(raw.tools).map(([name, ok]) => `${dot(p, ok ? "ok" : "off")} ${ok ? name : p.fg("dim", name)}`);
  out.push(section(pc, "tools"));
  out.push(fitTo(`  ${toolChips.join("    ")}`, pc.width));
  out.push("");
  // Provider × capability matrix.
  const caps = ["search", "read", "summarize"];
  const CW = 7;
  const capHead = ["search", "read", "sum"].map((c) => {
    const l = Math.floor((CW - c.length) / 2);
    return " ".repeat(l) + c + " ".repeat(CW - c.length - l);
  }).join("");
  out.push(section(pc, "providers"));
  out.push(fitTo(`${" ".repeat(Math.max(0, pc.width - CW * caps.length))}${dim(p, capHead)}`, pc.width));
  const nameW = Math.min(18, Math.max(...raw.providers.map((x) => x.name.length)) + 2);
  for (const x of raw.providers) {
    const h: Health = !x.enabled ? "off" : x.hasKey ? "ok" : "warn";
    const note = !x.enabled ? dim(p, "off") : !x.hasKey ? p.rgb(healthColor("warn"), "needs key") : x.keyed ? muted(p, "key set") : muted(p, "free");
    const cell = (c: string): string => {
      const g = x.caps.includes(c) ? (h === "ok" ? p.rgb(pc.accent, "■") : p.fg("borderMuted", "■")) : p.fg("borderMuted", "·");
      const l = Math.floor((CW - 1) / 2);
      return " ".repeat(l) + g + " ".repeat(CW - 1 - l);
    };
    const matrix = caps.map(cell).join("");
    const left = `${dot(p, h)} ${fitTo(h === "off" ? p.fg("dim", x.name) : x.name, nameW)}${fitTo(note, 11)}`;
    out.push(fitTo(`${fitTo(left, pc.width - CW * caps.length)}${matrix}`, pc.width));
  }
  if (raw.smartFetch || raw.wigolo) {
    out.push("");
    out.push(kv(pc, "smart-fetch", raw.smartFetch ? p.rgb(healthColor("bad"), `missing ${raw.smartFetch.join(", ")}`) : p.rgb(healthColor("ok"), "ready")));
    out.push(kv(pc, "wigolo", raw.wigolo.replace(/^✓ /, "")));
  }
  return out;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

interface MemoryRaw {
  project: string;
  projectCount: number;
  total: number;
  types: Record<string, number>;
  recall: boolean;
  write: boolean;
  pending: number;
  migrate: { phase: string; done: number; total: number } | "needed" | null;
}

const TYPE_COLORS: Record<string, RGB> = {
  decision: CRAB.orange,
  pattern: [0, 200, 240],
  summary: [190, 150, 240],
  preference: [120, 200, 120],
};

export function renderMemory(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as MemoryRaw | undefined;
  if (!raw) return [];
  const p = pc.paint;
  const out: string[] = [];
  out.push(
    ...tiles(pc, [
      { label: "project", value: compact(raw.projectCount), sub: raw.project, scope: "p" },
      { label: "global", value: compact(raw.total), sub: "all projects", scope: "g" },
      { label: "share", value: `${raw.total ? Math.round((raw.projectCount / raw.total) * 100) : 0}%`, sub: "project / global" },
    ]),
  );
  const types = Object.entries(raw.types).sort((a, b) => b[1] - a[1]);
  if (types.length) {
    out.push("");
    out.push(section(pc, "by type", "", "p"));
    const color = (t: string): RGB => TYPE_COLORS[t] ?? [140, 140, 160];
    out.push(fitTo(shareBar(p, types.map(([t, n]) => ({ value: n, color: color(t) })), pc.width, "▆"), pc.width));
    out.push(...legend(pc, types.map(([t, n]) => ({ label: `${t} ${n}`, color: color(t) }))));
  }
  out.push("");
  out.push(section(pc, "behaviour"));
  const mig = raw.migrate === null ? "—" : raw.migrate === "needed" ? p.rgb(healthColor("warn"), "needed · /unipi:memory migrate") : `${raw.migrate.phase} ${raw.migrate.done}/${raw.migrate.total}`;
  out.push(...kvColumns(pc, [["recall at start", on(pc, raw.recall)], ["save prompts", on(pc, raw.write)], ["pending writes", raw.pending ? p.rgb(healthColor("warn"), String(raw.pending)) : "0"], ["migration", mig]]));
  if (raw.migrate && raw.migrate !== "needed" && raw.migrate.total > 0) {
    out.push(fitTo(`  ${gauge(p, raw.migrate.done / raw.migrate.total, pc.width - 4, [pc.accent, CRAB.cream])}`, pc.width));
  }
  return out;
}

// ─── Input shortcuts ────────────────────────────────────────────────────────

interface KeysRaw {
  chordKey: string;
  tabInsertKey: string;
  stash: number;
}

/** Render a key combo as keycaps: ▕alt▏▕s▏ */
function keycaps(pc: PageContext, combo: string): string {
  const p = pc.paint;
  return combo
    .split("+")
    .map((k) => `${p.fg("borderMuted", "▕")}${p.on([235, 235, 240], [52, 56, 68], ` ${k} `)}${p.fg("borderMuted", "▏")}`)
    .join(p.fg("dim", "+"));
}

export function renderKeys(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as KeysRaw | undefined;
  if (!raw) return [];
  const p = pc.paint;
  const out: string[] = [];
  out.push(section(pc, "keys"));
  const rows: Array<[string, string]> = [
    [raw.chordKey, "open the shortcuts overlay"],
    [raw.tabInsertKey, "insert a literal tab"],
  ];
  for (const [k, what] of rows) {
    out.push("");
    out.push(fitTo(`  ${keycaps(pc, k)}   ${muted(p, what)}`, pc.width));
  }
  out.push("");
  out.push(section(pc, "stash"));
  out.push(fitTo(`  ${dot(p, raw.stash ? "ok" : "off")} ${raw.stash ? `${raw.stash} chars stashed` : dim(p, "empty")}`, pc.width));
  return out;
}

/** page id → renderer */
export const MODULE_RENDERERS: Record<string, (pc: PageContext) => string[]> = {
  mcp: renderMcp,
  compactor: renderCompactor,
  updater: renderUpdater,
  "web-api": renderWeb,
  memory: renderMemory,
  "input-shortcuts": renderKeys,
};
