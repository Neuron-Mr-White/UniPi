import { Box, Container, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { HandoffProgress, SidekickEvent } from "./sidekick-runtime.js";

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

export function sidekickWorkingHeader(theme: ThemeLike, progress: Pick<HandoffProgress, "toolCalls" | "startedAt">, label = "sidekick"): string {
  return `${theme.fg("accent", theme.bold(`◆ ${label} working`))} ${theme.fg("dim", `· ${String(progress.toolCalls)} tool calls · ${duration(Date.now() - progress.startedAt)}`)}`;
}

export class RailComponent implements Component {
  constructor(private readonly inner: Component, private readonly rail: string) {}

  render(width: number): string[] {
    return this.inner.render(Math.max(1, width - 2)).map((line) => `${this.rail} ${line}`);
  }

  invalidate(): void {
    this.inner.invalidate?.();
  }

  handleInput(data: string): void {
    this.inner.handleInput?.(data);
  }
}

export function frameSidekick(theme: ThemeLike & { bg: (color: string, text: string) => string }, status: "working" | "completed" | "error", content: Component): Component {
  const railColor = status === "working" ? "accent" : status === "completed" ? "success" : "error";
  const rail = theme.fg(railColor, "▍");
  const boxed = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  boxed.addChild(new RailComponent(content, rail));
  return boxed;
}

export interface TranscriptOptions {
  events: readonly SidekickEvent[];
  droppedEvents?: number;
  header: string;
  expanded: boolean;
  isPartial: boolean;
  report?: { text: string };
  renderText: (markdown: string) => Component;
}

/**
 * Non-expanded transcripts show this many most recent events. Windowing is the
 * only cap: a completed handoff renders its events, it is never collapsed into
 * a "N steps" stub.
 */
export const TRANSCRIPT_WINDOW = 8;

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

function toolComponent(theme: ThemeLike, event: Extract<SidekickEvent, { kind: "tool" }>, expanded: boolean): Text {
  const title = `${event.isError ? theme.fg("error", "✗ ") : ""}${theme.fg("toolTitle", theme.bold(event.name))}`;
  const argument = primaryArg(event.name, event.args);
  const lines = [`${title}${argument.length > 0 ? ` ${theme.fg("accent", argument)}` : ""}`];
  if (!event.done) {
    lines[0] += theme.fg("warning", " ⋯ running");
  } else if (event.output.length > 0) {
    const output = event.output.split("\n");
    const visible = expanded ? output.slice(-40) : output.slice(-3);
    lines.push(...visible.map((line) => theme.fg("toolOutput", truncate(line, 160))));
  }
  return new Text(lines.join("\n"), 0, 0);
}

export function renderSidekickTranscript(theme: ThemeLike, opts: TranscriptOptions): Component {
  const box = new Container();
  box.addChild(new Text(opts.header, 0, 0));

  const dropped = opts.droppedEvents ?? 0;
  const start = opts.expanded ? 0 : Math.max(0, opts.events.length - TRANSCRIPT_WINDOW);
  if (opts.expanded && dropped > 0) {
    box.addChild(new Text(theme.fg("dim", `… ${String(dropped)} earliest steps dropped`), 0, 0));
  } else if (start > 0) {
    box.addChild(new Text(theme.fg("dim", `… ${String(start + dropped)} earlier steps`), 0, 0));
  }

  for (const event of opts.events.slice(start)) {
    if (event.kind === "tool") box.addChild(toolComponent(theme, event, opts.expanded));
    else if (event.text.trim()) box.addChild(opts.renderText(event.text.trim()));
  }

  if (!opts.isPartial && opts.report?.text) {
    // The final assistant message usually IS the report; don't print it twice.
    const last = opts.events.at(-1);
    if (!(last?.kind === "text" && last.text.trim() === opts.report.text.trim())) {
      box.addChild(new Text(theme.fg("dim", "── report ──"), 0, 0));
      box.addChild(opts.renderText(opts.report.text));
    }
  }
  return box;
}
