/**
 * Mermaid source for a graph/swarm long-horizon run (UNI-258) — THE shared
 * generator. The TUI's chart mode (`/unipi:visualize-progress`, `m`) renders
 * it to PNG; the app's Progress sheet renders the same source with mermaid.
 *
 * Ported verbatim from the app (unipi-app apps/mobile/src/lib/chat/progress.ts
 * `progressMermaid`, UNI-222). This file is now the source of truth: the app
 * should import/copy it from here rather than keep its own copy. It is pure
 * (no node/pi imports beyond types) so it can be copied as-is.
 *
 * Graph: one subgraph per wave (left→right), an edge per dependency.
 * Swarm: one "items" subgraph, rows of SWARM_COLS, no edges. Deterministic for
 * the same run (renderers cache by source).
 */

import type { LhProgressItem, LhProgressRun } from "@pi-unipi/core";

type Item = Pick<LhProgressItem, "id" | "label" | "status" | "deps" | "wave">;
type Run = Pick<LhProgressRun, "mode" | "title" | "counts"> & { items: Item[] };

/** Mermaid-safe node id (ids are model-chosen strings). */
export function nodeId(id: string, index: number): string {
  return `n${index}_${id.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 24)}`;
}

/** Text inside a quoted mermaid label: no quotes / brackets / markup survive. */
export function mermaidText(text: string, max = 42): string {
  const flat = text
    .replace(/\s+/g, " ")
    .replace(/["`]/g, "'")
    .replace(/[<>{}[\]|#;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export const MERMAID_GLYPH: Record<LhProgressItem["status"], string> = { queued: "·", ready: "○", running: "▶", done: "✓", failed: "✗", aborted: "⊘" };

/**
 * Status colours from the app tokens (APP DESIGN.md §1.1–1.3): working = claw,
 * done = wm-green, failed = wm-red, aborted = wm-yellow, waiting = surfaces.
 */
export const CLASS_DEFS = [
  "classDef queued fill:#1C1917,stroke:#2E2825,color:#A39A90",
  "classDef ready fill:#1C1917,stroke:#A39A90,color:#F5EFE6",
  "classDef running fill:#3A2210,stroke:#F07818,color:#F5EFE6,stroke-width:2px",
  "classDef done fill:#16301A,stroke:#5AD25A,color:#F5EFE6",
  "classDef failed fill:#3A1412,stroke:#F03C32,color:#F5EFE6,stroke-width:2px",
  "classDef aborted fill:#33290E,stroke:#FAC828,color:#F5EFE6",
];

/** Swarm chart columns (a phone-width grid). */
export const SWARM_COLS = 3;

/** Wave / item-group boxes: surface-1 on the chart's surface, line border, muted title. */
const SUBGRAPH_STYLE = "fill:#141211,stroke:#2E2825,color:#A39A90";

/** Only graph/swarm runs with items have a chart. */
export function hasProgressChart(run: { mode: string; items: unknown[] } | undefined): boolean {
  return !!run && (run.mode === "graph" || run.mode === "swarm") && run.items.length > 0;
}

export function progressMermaid(run: Run): string {
  const lines: string[] = ["flowchart LR"];
  const ids = new Map<string, string>();
  run.items.forEach((item, i) => ids.set(item.id, nodeId(item.id, i)));
  const node = (item: Item) => {
    const label = `${MERMAID_GLYPH[item.status]} ${mermaidText(item.id, 28)}<br/>${mermaidText(item.label)}`;
    return `    ${ids.get(item.id)}["${label}"]:::${item.status}`;
  };
  if (run.mode === "graph") {
    const waves = new Map<number, Item[]>();
    for (const item of run.items) {
      const w = item.wave ?? 0;
      waves.set(w, [...(waves.get(w) ?? []), item]);
    }
    for (const w of [...waves.keys()].sort((a, b) => a - b)) {
      const items = waves.get(w)!;
      const done = items.filter((i) => i.status === "done").length;
      lines.push(`  subgraph wave${w}["Wave ${w + 1} · ${done}/${items.length}"]`);
      lines.push("    direction TB");
      for (const item of items) lines.push(node(item));
      lines.push("  end");
      lines.push(`  style wave${w} ${SUBGRAPH_STYLE}`);
    }
    for (const item of run.items) {
      for (const dep of item.deps) {
        const from = ids.get(dep);
        if (from) lines.push(`  ${from} --> ${ids.get(item.id)}`);
      }
    }
  } else {
    lines.push(`  subgraph items["${mermaidText(run.title, 60)} · ${run.counts.done}/${run.counts.total}"]`);
    for (const item of run.items) lines.push(node(item));
    // Rows of SWARM_COLS: invisible links chain a row left→right; unlinked rows stack.
    for (let i = 0; i < run.items.length; i += SWARM_COLS) {
      const row = run.items.slice(i, i + SWARM_COLS).map((it) => ids.get(it.id));
      if (row.length > 1) lines.push(`    ${row.join(" ~~~ ")}`);
    }
    lines.push("  end");
    lines.push(`  style items ${SUBGRAPH_STYLE}`);
  }
  lines.push(...CLASS_DEFS.map((d) => `  ${d}`));
  return lines.join("\n");
}
