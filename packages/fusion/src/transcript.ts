import { Markdown, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  nativeToolComponent,
  renderStyle,
  styledComponent,
  styledTextLines,
  styledToolCallLines,
} from "@pi-unipi/utility/src/render/styled.js";
import { paintLine, replyBg, trimEdgeBlankLines } from "@pi-unipi/utility/src/render/reply-bg.js";
import type { SpacingGroupPosition } from "@pi-unipi/utility/src/render/spacing.js";
import type { SidekickStep } from "./sidekick-runtime.js";

export interface ThemeLike {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
  getBgAnsi?: (key: string) => string;
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

/** The sidekick rail: muted left border on the custom-message background —
 *  the tinted panel Devin draws around delegated work. */
const RAIL = "▏ ";

function railBg(theme: ThemeLike): string {
  try {
    return theme.getBgAnsi?.("customMessageBg") || replyBg();
  } catch {
    return replyBg();
  }
}

/**
 * One sidekick step in the lead chat, drawn in the active render style
 * (simple mcode row / advanced header+gutter / regular pi card) behind a
 * `▏` border on the custom-message background — every line of the step sits
 * on the rail so a sidekick block reads as one tinted unit.
 *
 * Steps carry `spacingGroup: "sidekick"`: adjacent steps in the transcript
 * join into one rail block with no blank separator, and the spacing patch
 * reports each member's position so a consecutive run of tool steps draws
 * the same `├…├…└` tree the lead's tools get (last member or a step
 * followed by prose gets `└`).
 */
export function renderSidekickStep(step: SidekickStep, expanded: boolean, theme: ThemeLike): Component {
  const t = theme;
  let pos: SpacingGroupPosition | undefined;
  let native: (Component & { setExpanded?: (b: boolean) => void }) | null | undefined;
  const comp = styledComponent((width: number) => {
    const inner = Math.max(8, width - 2);
    const style = renderStyle();
    let lines: string[];
    if (step.kind === "text") {
      lines = styledTextLines(style, step.text, { thinking: expanded ? step.thinking : undefined }, t, inner);
    } else if (style === "regular") {
      if (native === undefined) {
        native = nativeToolComponent({
          name: step.name,
          args: step.args,
          output: step.output,
          isError: step.isError,
          expanded,
        }) ?? null;
      }
      if (native !== null) {
        native.setExpanded?.(expanded);
        lines = trimEdgeBlankLines(native.render(inner));
      } else {
        lines = styledToolCallLines("regular", {
          name: step.name,
          arg: step.arg,
          output: step.output,
          isError: step.isError,
          expanded,
          durationMs: step.durationMs,
        }, t, inner);
      }
    } else {
      lines = styledToolCallLines(style, {
        name: step.name,
        arg: step.arg,
        output: step.output,
        isError: step.isError,
        expanded,
        durationMs: step.durationMs,
        connector: pos !== undefined && pos.nextKind === "tool" ? "├" : "└",
      }, t, inner);
    }
    const bg = railBg(t);
    return lines.map((l) => paintLine(`${t.fg("borderMuted", RAIL)}${l}`, width, bg));
  }) as Component & {
    spacingGroup: string;
    spacingKind: string;
    setGroupPosition: (p: SpacingGroupPosition) => void;
  };
  comp.spacingGroup = "sidekick";
  comp.spacingKind = step.kind === "tool" ? "tool" : "text";
  comp.setGroupPosition = (p) => {
    pos = p;
  };
  return comp;
}
