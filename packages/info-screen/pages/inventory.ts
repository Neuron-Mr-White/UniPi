/**
 * Tools · Skills · Modules — what this pi session has loaded.
 *
 * Read from pi itself (getAllTools / getCommands / module announcements),
 * not by scanning the filesystem: cheaper, and it is what is ACTUALLY live.
 * Names are laid out in columns with a coloured source marker, and a share
 * bar on top shows where things come from.
 */

import { compact, fitTo, grid, rightTo, shareBar, type RGB } from "@pi-unipi/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { GroupData, PageContext } from "../types.js";
import { dim, empty, legend, muted, section, tiles } from "../tui/page-kit.js";

export interface Named {
  name: string;
  group: string;
  active?: boolean;
}

export interface InventoryRaw {
  items: Named[];
  groups: Array<[string, number]>;
  activeCount?: number;
}

const GROUP_COLORS: RGB[] = [[0, 200, 240], [240, 120, 24], [190, 150, 240], [120, 200, 120], [240, 192, 48], [230, 120, 200], [78, 201, 176], [140, 140, 160]];

/** Stable colour per group label (order of first appearance). */
function colorMap(groups: ReadonlyArray<[string, number]>): Map<string, RGB> {
  const m = new Map<string, RGB>();
  groups.forEach(([g], i) => m.set(g, GROUP_COLORS[i % GROUP_COLORS.length]!));
  return m;
}

export function inventoryData(items: Named[], activeCount?: number): GroupData {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const sorted = [...items].sort((a, b) => {
    const ga = groups.findIndex(([g]) => g === a.group);
    const gb = groups.findIndex(([g]) => g === b.group);
    return ga - gb || a.name.localeCompare(b.name);
  });
  const raw: InventoryRaw = { items: sorted, groups, activeCount };
  return {
    total: { value: String(items.length) },
    groups: { value: groups.map(([g, n]) => `${n} ${g}`).join(", ") },
    raw: { value: "", raw },
  };
}

export function renderInventory(pc: PageContext, noun: string, emptyHint: string): string[] {
  const raw = pc.data.raw?.raw as InventoryRaw | undefined;
  if (!raw || raw.items.length === 0) return empty(pc, `No ${noun} loaded`, emptyHint);
  const p = pc.paint;
  const colors = colorMap(raw.groups);
  const out: string[] = [];

  const headline: Array<{ label: string; value: string; sub?: string }> = [{ label: noun, value: String(raw.items.length), sub: `from ${raw.groups.length} source${raw.groups.length === 1 ? "" : "s"}` }];
  if (raw.activeCount !== undefined) headline.push({ label: "active", value: String(raw.activeCount), sub: `${raw.items.length - raw.activeCount} switched off` });
  for (const [g, n] of raw.groups.slice(0, raw.activeCount !== undefined ? 2 : 3)) headline.push({ label: g, value: compact(n), sub: `${Math.round((n / raw.items.length) * 100)}%`, stops: [colors.get(g)!, colors.get(g)!] } as never);
  out.push(...tiles(pc, headline));
  out.push("");
  out.push(fitTo(shareBar(p, raw.groups.map(([g, n]) => ({ value: n, color: colors.get(g)! })), pc.width, "▆"), pc.width));
  out.push(...legend(pc, raw.groups.map(([g, n]) => ({ label: `${g} ${n}`, color: colors.get(g)! }))));
  out.push("");

  out.push(section(pc, `all ${noun}`, dim(p, "● active  ○ off")));
  const items = raw.items.map((i) => {
    const c = colors.get(i.group) ?? [140, 140, 160];
    const mark = i.active === false ? p.rgb(c, "○") : p.rgb(c, "●");
    const name = i.active === false ? p.fg("dim", i.name) : i.name;
    return { text: `${mark} ${name}`, plain: visibleWidth(i.name) + 2 };
  });
  const g = grid(items, pc.width, 16);
  out.push(...g.lines);
  return out;
}

/** Modules page: what each unipi module adds, plus other extensions. */
export interface ModulesRaw {
  version: string;
  unipi: Array<{ name: string; ms: number; tools: number; commands: number; shortcuts: number; settings: number }>;
  others: Array<{ name: string; kind: string; tools: number; commands: number }>;
  totalLoadMs: number;
}

/** A module whose register call took longer than this is worth a look. */
const SLOW_MS = 20;

export function renderModules(pc: PageContext): string[] {
  const raw = pc.data.raw?.raw as ModulesRaw | undefined;
  if (!raw || (raw.unipi.length === 0 && raw.others.length === 0)) return empty(pc, "No modules announced yet", "modules report in as they finish loading");
  const p = pc.paint;
  const out: string[] = [];
  const sum = (k: "tools" | "commands" | "shortcuts" | "settings"): number => raw.unipi.reduce((a, m) => a + (m[k] ?? 0), 0);
  const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : n < 1 ? "<1ms" : `${Math.round(n)}ms`);
  out.push(
    ...tiles(pc, [
      { label: "modules", value: String(raw.unipi.length), sub: raw.version ? `unipi v${raw.version}` : "unipi" },
      { label: "tools", value: String(sum("tools")), sub: `${sum("commands")} commands` },
      { label: "settings", value: String(sum("settings")), sub: "in /unipi:settings" },
      { label: "boot", value: ms(raw.totalLoadMs), sub: "until ready" },
    ]),
  );

  if (raw.unipi.length > 0) {
    out.push("");
    const T: RGB = [0, 200, 240];
    const C: RGB = [240, 120, 24];
    const S: RGB = [190, 150, 240];
    const K: RGB = [120, 200, 120];
    out.push(section(pc, "what each module adds", `${p.rgb(T, "■")} ${dim(p, "tools")}  ${p.rgb(C, "■")} ${dim(p, "commands")}  ${p.rgb(S, "■")} ${dim(p, "settings")}  ${p.rgb(K, "■")} ${dim(p, "keys")}`));
    const sorted = [...raw.unipi].sort((a, b) => b.tools + b.commands + b.settings - (a.tools + a.commands + a.settings) || a.name.localeCompare(b.name));
    const nameW = Math.min(20, Math.max(...sorted.map((m) => m.name.length)) + 1);
    const twoCol = pc.width >= 100;
    const colW = twoCol ? Math.floor((pc.width - 4) / 2) : pc.width;
    const countsW = 15;
    const msW = 6;
    const barW = Math.max(6, colW - nameW - countsW - msW - 3);
    const most = Math.max(1, ...sorted.map((m) => m.tools + m.commands + m.settings + m.shortcuts));
    const scale = Math.min(1, barW / most);
    const cells = sorted.map((m) => {
      // One cell per item when it fits, scaled down otherwise; ≥1 cell per non-zero kind.
      const seg = (n: number, c: RGB, g: string): string => (n > 0 ? p.rgb(c, g.repeat(Math.max(1, Math.round(n * scale)))) : "");
      let bar = seg(m.tools, T, "■") + seg(m.commands, C, "■") + seg(m.settings, S, "■") + seg(m.shortcuts, K, "■");
      if (visibleWidth(bar) > barW) bar = fitTo(bar, barW - 1) + dim(p, "›");
      const counts = [m.tools ? p.rgb(T, String(m.tools)) : dim(p, "·"), m.commands ? p.rgb(C, String(m.commands)) : dim(p, "·"), m.settings ? p.rgb(S, String(m.settings)) : dim(p, "·")]
        .map((x) => rightTo(x, 3))
        .join(" ");
      const slow = m.ms >= SLOW_MS;
      const t = m.ms > 0 ? (slow ? p.bold(p.rgb([240, 190, 60], ms(m.ms))) : dim(p, ms(m.ms))) : dim(p, "—");
      return fitTo(`${fitTo(slow ? p.bold(m.name) : m.name, nameW)}${fitTo(bar, barW)} ${rightTo(counts, countsW - 2)} ${rightTo(t, msW)}`, colW);
    });
    if (twoCol) {
      const half = Math.ceil(cells.length / 2);
      for (let i = 0; i < half; i++) out.push(fitTo(`${cells[i] ?? ""}    ${cells[i + half] ?? ""}`, pc.width));
    } else out.push(...cells);
    const slowOnes = raw.unipi.filter((m) => m.ms >= SLOW_MS);
    if (slowOnes.length) out.push(fitTo(`${p.rgb([240, 190, 60], "▲")} ${dim(p, `slow to register (≥${SLOW_MS}ms): ${slowOnes.map((m) => m.name).join(", ")}`)}`, pc.width));
  }
  if (raw.others.length > 0) {
    out.push("");
    out.push(section(pc, "other extensions", dim(p, "tools · commands")));
    const items = raw.others.map((o) => {
      const tail = `${o.tools}·${o.commands}`;
      return { text: `${p.rgb([110, 150, 255], "◆")} ${o.name} ${p.fg("dim", tail)}`, plain: o.name.length + tail.length + 3 };
    });
    out.push(...grid(items, pc.width, 18).lines);
  }
  return out;
}
