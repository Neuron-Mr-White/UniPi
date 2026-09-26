import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { SidekickStep } from "./sidekick-runtime.js";

export interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
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

const COLLAPSED_OUTPUT_LINES = 3;

/**
 * One sidekick step in the lead chat: `◆ <name> <arg>` plus a few dim output
 * lines collapsed; expanded shows all stored output. Text steps are `◆` +
 * markdown, thinking dim and only when expanded.
 */
export function renderSidekickStep(step: SidekickStep, expanded: boolean, theme: ThemeLike): Component {
  const t = theme;
  const mark = step.kind === "tool" && step.isError ? t.fg("error", "✗") : t.fg("accent", "◆");
  if (step.kind === "text") {
    const text = step.text;
    const thinking = step.thinking;
    return {
      invalidate() {},
      render(width: number) {
        const lines: string[] = [];
        if (expanded && thinking) {
          lines.push(`${mark} ${t.fg("dim", "thinking")}`);
          for (const l of thinking.split("\n")) lines.push(`  ${t.fg("dim", truncate(l, 160))}`);
        }
        const md = markdownText(text).render(Math.max(1, width - 2));
        md.forEach((l, i) => lines.push(i === 0 ? `${mark} ${l}` : `  ${l}`));
        return lines;
      },
    };
  }
  const header = `${mark} ${t.fg("toolTitle", t.bold(step.name))}${step.arg ? ` ${t.fg("accent", step.arg)}` : ""}`;
  const lines = [header];
  if (step.output.length > 0) {
    const out = step.output.split("\n");
    const visible = expanded ? out : out.slice(-COLLAPSED_OUTPUT_LINES);
    if (!expanded && out.length > COLLAPSED_OUTPUT_LINES) {
      lines.push(t.fg("dim", `… ${String(out.length - COLLAPSED_OUTPUT_LINES)} earlier lines`));
    }
    lines.push(...visible.map((l) => `  ${t.fg("toolOutput", truncate(l, 160))}`));
  }
  return new Text(lines.join("\n"), 0, 0);
}
