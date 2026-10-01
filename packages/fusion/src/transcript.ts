import { Markdown, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { renderDelegatedStep, type DelegatedStep } from "@pi-unipi/utility/src/render/delegated.js";
import type { SidekickStep } from "./sidekick-runtime.js";

export interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  getBgAnsi?: (key: string) => string;
  /** Colour mode when the caller knows it — the delegated panel uses it for
   *  its truecolor/256 rail+fill+fg fallbacks. */
  getColorMode?: () => "truecolor" | "256color";
}

export function duration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function markdownText(markdown: string): Component {
  return new Markdown(markdown, 0, 0, getMarkdownTheme());
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function primaryArg(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const value = name === "bash"
    ? args.command
    : name === "read" || name === "edit" || name === "write"
      ? args.path ?? args.file_path ?? args.filePath
      : name === "sidekick"
        ? args.message
        : Object.values(args).find((entry) => typeof entry === "string");
  return typeof value === "string" ? truncate(firstLine(value), 100) : "";
}

// ─── sidekick-step entry renderer (Devin-style merged steps) ────────────────

export interface StepIdentity {
  /** spacingGroup run — unique per handoff so resumed handoffs don't merge. */
  group?: string;
  /** Panel header drawn once on the group's first position (e.g. "Sidekick"). */
  label?: string;
}

/**
 * One sidekick step in the lead chat, drawn by the shared delegated-panel
 * helper: the active render style behind the approved cyan `▏` rail on a
 * single dark-cyan fill. Steps carry `spacingGroup` so adjacent steps of the
 * same handoff join into one continuous panel (`├…└` tree, no blank
 * separators); the optional identity comes from the persisted entry (older
 * entries without one fall back to the shared "sidekick" group).
 */
export function renderSidekickStep(step: SidekickStep, expanded: boolean, theme: ThemeLike, identity?: StepIdentity): Component {
  return renderDelegatedStep(step as DelegatedStep, expanded, theme as never, {
    group: identity?.group ?? "sidekick",
    label: identity?.label,
  });
}
