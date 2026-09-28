/**
 * @pi-unipi/skill-registry — /unipi:skills manager (hub-kit look)
 *
 * One row per skill, grouped by where it lives (vault, project, user,
 * UniPi, packages). The value column shows the effective state and the two
 * layers that produce it: `on · listed   g:on p:–`.
 *
 * Keys: ↑↓/jk move · space on/off at the edited scope · d listed/unlisted ·
 * enter details · g switch edited scope · p proxy on/off · / search · esc close.
 * Both toggles cycle the edited layer: unset → set → opposite → unset, so a
 * project can override the global choice or fall back to it.
 */

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  boxInnerWidth,
  frameOverlay,
  hubBoldText as bold,
  hubClampScroll,
  hubDimText as dim,
  hubExactRow,
  hubFrameTitle,
  hubHeaderBand,
  hubHintLine,
  hubKey,
  hubMaxRows,
  hubMoreAbove,
  hubMoreBelow,
  hubRowColumns,
  HubSearch,
  hubTheme,
  setHubTheme,
  setSettings,
  type HubKey,
} from "@pi-unipi/core";
import { effectiveState, skillSource, type CatalogSkill, type SkillSource } from "./registry.js";
import { readLayerStates, readSkillsSettings, writeSkillState, type SkillState, NAMESPACE } from "./settings.js";

const MARK_NS = "skills";
const SOURCE_LABEL: Record<SkillSource, string> = {
  vault: "Vault (~/.unipi/skill-vault) — off until turned on",
  project: "Project",
  user: "User",
  unipi: "UniPi bundled",
  package: "Packages",
};
const SOURCE_ORDER: SkillSource[] = ["vault", "project", "user", "unipi", "package"];

type Row = { kind: "header"; source: SkillSource } | { kind: "skill"; skill: CatalogSkill; source: SkillSource };

export interface PanelParams {
  cwd: string;
  vault: string;
  skills: () => CatalogSkill[];
  terminalRows?: number;
  onChange?: () => void;
}

/** Cycle one layer's boolean: unset → first → !first → unset. */
export function cycle(current: boolean | undefined, first: boolean): boolean | undefined {
  if (current === undefined) return first;
  if (current === first) return !first;
  return undefined;
}

function layerMark(v: boolean | undefined, on: string, off: string): string {
  return v === undefined ? "–" : v ? on : off;
}

export function renderSkillsPanel(params: PanelParams) {
  return (tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (r: null) => void) => {
    setHubTheme(theme);
    let scope: "global" | "project" = "project";
    let cursor = 0;
    let scroll = 0;
    let expanded: string | null = null;
    let search: HubSearch | null = null;
    let filter = "";
    let rows: Row[] = [];

    const rebuild = () => {
      const f = filter.toLowerCase();
      const skills = params.skills().filter((s) => !f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f));
      rows = [];
      for (const source of SOURCE_ORDER) {
        const mine = skills.filter((s) => skillSource(s, params.cwd, params.vault) === source).sort((a, b) => a.name.localeCompare(b.name));
        if (mine.length === 0) continue;
        rows.push({ kind: "header", source });
        for (const skill of mine) rows.push({ kind: "skill", skill, source });
      }
      const selectable = rows.map((r, i) => (r.kind === "skill" ? i : -1)).filter((i) => i >= 0);
      if (!selectable.includes(cursor)) cursor = selectable[0] ?? 0;
    };
    rebuild();

    const viewport = () => hubMaxRows(params.terminalRows ?? 30, 3);
    const move = (dir: 1 | -1) => {
      for (let i = cursor + dir; i >= 0 && i < rows.length; i += dir) {
        if (rows[i]!.kind === "skill") {
          cursor = i;
          return;
        }
      }
    };
    const current = (): Extract<Row, { kind: "skill" }> | undefined => {
      const r = rows[cursor];
      return r?.kind === "skill" ? r : undefined;
    };
    const toggle = (field: keyof SkillState) => {
      const row = current();
      if (!row) return;
      const layers = readLayerStates(params.cwd);
      const layer = layers[scope][row.skill.name]?.[field];
      const eff = effectiveState(readSkillsSettings(params.cwd).states[row.skill.name], row.source);
      writeSkillState(params.cwd, scope, row.skill.name, field, cycle(layer, !eff[field]));
      params.onChange?.();
    };

    function handleInput(data: string) {
      if (search) {
        const ev = search.handle(data);
        filter = ev === "exited" ? "" : search.filter;
        if (ev !== "typing") search = null;
        rebuild();
        return;
      }
      const key: HubKey = hubKey(data);
      if (key === "back") return done(null);
      if (key === "up") move(-1);
      else if (key === "down") move(1);
      else if (key === "quick") toggle("enabled");
      else if (key === "activate") expanded = expanded === current()?.skill.name ? null : current()?.skill.name ?? null;
      else if (key === "search") search = new HubSearch();
      else if (typeof key === "object") {
        if (key.char === "d") toggle("discoverable");
        else if (key.char === "g") scope = scope === "global" ? "project" : "global";
        else if (key.char === "p") {
          setSettings(NAMESPACE, { proxy: !readSkillsSettings(params.cwd).proxy }, "global", params.cwd);
          params.onChange?.();
        }
      }
      scroll = hubClampScroll(rows.map((r) => r.kind), cursor, scroll, viewport());
    }

    function render(width: number): string[] {
      const inner = boxInnerWidth(width);
      const settings = readSkillsSettings(params.cwd);
      const layers = readLayerStates(params.cwd);
      const count = rows.filter((r) => r.kind === "skill").length;
      const body: string[] = [];
      body.push(hubHeaderBand({
        inner,
        namespace: MARK_NS,
        text: `Skills — editing ${scope} · proxy ${settings.proxy ? "on" : "off"} · ${count} skills${filter ? ` · "${filter}"` : ""}`,
      }));
      if (!settings.proxy) {
        body.push(hubExactRow(dim("  Proxy is off: choices are saved but not applied, and vault skills stay hidden. p turns it on."), inner));
      }
      if (search) body.push(hubExactRow(`  ${search.input.render(inner - 2)[0] ?? ""}`, inner));

      const view = viewport();
      scroll = hubClampScroll(rows.map((r) => r.kind), cursor, scroll, view);
      if (scroll > 0) body.push(hubMoreAbove(scroll, inner));
      const end = Math.min(rows.length, scroll + view);
      for (let i = scroll; i < end; i++) {
        const row = rows[i]!;
        if (row.kind === "header") {
          body.push(hubExactRow(`  ${bold(SOURCE_LABEL[row.source])}`, inner));
          continue;
        }
        const name = row.skill.name;
        const eff = effectiveState(settings.states[name], row.source);
        const g = layers.global[name] ?? {};
        const p = layers.project[name] ?? {};
        const status = !eff.enabled ? "off" : eff.discoverable ? "on · listed" : "on · unlisted";
        const value = `${status}   g:${layerMark(g.enabled, "on", "off")}${g.discoverable === false ? "/unl" : ""} p:${layerMark(p.enabled, "on", "off")}${p.discoverable === false ? "/unl" : ""}`;
        const glyph = eff.enabled ? (eff.discoverable ? "●" : "◐") : "○";
        body.push(hubExactRow(hubRowColumns({ inner, selected: i === cursor, label: `${glyph} ${name}`, value, markNamespace: MARK_NS }), inner));
        if (expanded === name) {
          const desc = row.skill.description.replace(/\s+/g, " ");
          for (let at = 0; at < Math.min(desc.length, (inner - 8) * 3); at += inner - 8) {
            body.push(hubExactRow(dim(`      ${desc.slice(at, at + inner - 8)}`), inner));
          }
          body.push(hubExactRow(dim(`      ${row.skill.filePath ?? ""}`), inner));
        }
      }
      if (rows.length - end > 0) body.push(hubMoreBelow(rows.length - end, inner));
      body.push(hubHintLine("space on/off · d listed · enter details · g scope · p proxy · / search · esc close", inner));
      return frameOverlay(body, width, {
        title: bold(hubFrameTitle("skills", [], `— ${scope}`)),
        borderFg: (t) => hubTheme.fg("borderMuted", t),
      });
    }

    return { render, invalidate: () => tui.requestRender(), handleInput };
  };
}
