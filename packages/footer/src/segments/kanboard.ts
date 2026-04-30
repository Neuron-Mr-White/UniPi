/**
 * @pi-unipi/footer — Kanboard segments
 *
 * Segment renderers for the kanboard group: docs_count, tasks_done,
 * tasks_total, task_pct.
 * Reads directly from kanboard's parser registry (no events).
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

/**
 * Try to read kanboard data from globalThis registry.
 * Kanboard doesn't emit events — it exposes its parser via globalThis.
 */
function getKanboardData(): Record<string, unknown> | null {
  try {
    const registry = (globalThis as Record<string, unknown>).__unipi_kanboard_registry;
    if (!registry || typeof registry !== "object") return null;
    return registry as Record<string, unknown>;
  } catch {
    return null;
  }
}

function renderDocsCountSegment(ctx: FooterSegmentContext): RenderedSegment {
  const kb = getKanboardData();
  const value = kb?.docsCount ?? "—";
  const content = withIcon("docsCount", `${value}`);
  return { content: applyColor("kanboard", content, ctx.theme, ctx.colors), visible: true };
}

function renderTasksDoneSegment(ctx: FooterSegmentContext): RenderedSegment {
  const kb = getKanboardData();
  const value = kb?.tasksDone ?? "—";
  const content = withIcon("tasksDone", `${value}`);
  return { content: applyColor("kanboard", content, ctx.theme, ctx.colors), visible: true };
}

function renderTasksTotalSegment(ctx: FooterSegmentContext): RenderedSegment {
  const kb = getKanboardData();
  const value = kb?.tasksTotal ?? "—";
  const content = withIcon("tasksTotal", `${value}`);
  return { content: applyColor("kanboard", content, ctx.theme, ctx.colors), visible: true };
}

function renderTaskPctSegment(ctx: FooterSegmentContext): RenderedSegment {
  const kb = getKanboardData();
  const done = kb?.tasksDone as number | undefined;
  const total = kb?.tasksTotal as number | undefined;

  if (done === undefined || total === undefined || total === 0) {
    return { content: "", visible: false };
  }

  const pct = Math.round((done / total) * 100);
  const content = withIcon("taskPct", `${pct}%`);
  return { content: applyColor("kanboard", content, ctx.theme, ctx.colors), visible: true };
}

export const KANBOARD_SEGMENTS: FooterSegment[] = [
  { id: "docs_count", label: "Docs Count", icon: "", render: renderDocsCountSegment, defaultShow: true },
  { id: "tasks_done", label: "Tasks Done", icon: "", render: renderTasksDoneSegment, defaultShow: true },
  { id: "tasks_total", label: "Tasks Total", icon: "", render: renderTasksTotalSegment, defaultShow: true },
  { id: "task_pct", label: "Task %", icon: "", render: renderTaskPctSegment, defaultShow: true },
];
