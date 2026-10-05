/**
 * @pi-unipi/background-tasks — chat cards (badge + leader, no tinted box)
 *
 * Background-task launch/completion messages render as one dotted-leader line
 * (same visual language as @pi-unipi/core's badge/leader kit used elsewhere —
 * subagents, etc.): a padded four-letter accent chip, the bold task name, a
 * dotted leader, and a dim right side.
 *
 *    BG   Run full test suite ························· started · wakes agent
 *    DONE Run full test suite ························· exit 0 · 25s · agent woken
 *    FAIL Run full test suite ························· exit 101 · 12s · agent woken
 *    STOP Run full test suite ························· killed · 4s
 *
 * Collapsed is the chip line only. Expanded adds: the dim `$ command` line, an
 * error line in error color, output tail lines, and the dim output path + id.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { badge, leader, STATE_COLOR, type RunState } from "@pi-unipi/core";
import { formatDuration, taskDisplayName, type BgTaskSnapshot } from "./types.js";

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

/** Width-aware component — same shape as subagents' `lines()` helper. */
const lines = (render: (w: number) => string[]): Component => ({ invalidate() {}, render });

const CHIP: Record<"running" | "completed" | "failed" | "killed", string> = {
  running: "BG  ",
  completed: "DONE",
  failed: "FAIL",
  killed: "STOP",
};

function runStateFor(status: BgTaskSnapshot["status"]): RunState {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "killed") return "cancelled";
  return "failed";
}

function chip(theme: ThemeLike, status: BgTaskSnapshot["status"]): string {
  return badge(theme, STATE_COLOR[runStateFor(status)], CHIP[status]);
}

function head(theme: ThemeLike, task: BgTaskSnapshot, right: string, width: number): string {
  return leader(theme, `${chip(theme, task.status)} ${theme.bold(taskDisplayName(task))}`, theme.fg("dim", right), width);
}

function commandLine(theme: ThemeLike, task: BgTaskSnapshot, width: number): string {
  const text = `  $ ${task.command.length > 120 ? `${task.command.slice(0, 120)}…` : task.command}`;
  return truncateToWidth(theme.fg("dim", text), width, "…");
}

/** `bg_run` result card: `BG   <name> ···· started · wakes agent`. */
export function renderLaunchCard(theme: ThemeLike, task: BgTaskSnapshot, expanded = false): Component {
  const wake = task.triggerOnCompletion ? "wakes agent" : task.notifyOnCompletion ? "notifies" : "silent";
  return lines((w) => {
    const out = [head(theme, task, `started · ${wake}`, w)];
    if (!expanded) return out;
    out.push(commandLine(theme, task, w));
    if (task.error) out.push(truncateToWidth(theme.fg("error", `  ${task.error}`), w, "…"));
    for (const line of task.outputTail ?? []) out.push(truncateToWidth(theme.fg("toolOutput", `  ${line}`), w, "…"));
    out.push(truncateToWidth(theme.fg("dim", `  ${task.outputPath}`), w, "…"));
    out.push(truncateToWidth(theme.fg("dim", `  (${task.id})`), w, "…"));
    return out;
  });
}

/** Completion notification card: `DONE <name> ···· exit 0 · 25s · agent woken` + tail. */
export function renderCompletionCard(
  theme: ThemeLike,
  task: BgTaskSnapshot | undefined,
  expanded = false,
): Component {
  if (task === undefined) {
    return lines((w) => [leader(theme, `${badge(theme, STATE_COLOR.completed, "DONE")} ${theme.bold("bg task")}`, "", w)]);
  }
  const meta: string[] = [];
  if (task.status === "killed") {
    if (task.endTime !== undefined) meta.push(formatDuration(task.endTime - task.startTime));
    meta.unshift("killed");
  } else {
    if (task.exitCode !== undefined && task.exitCode !== null) meta.push(`exit ${String(task.exitCode)}`);
    else if (task.status === "failed") meta.push(task.error ? "error" : "failed");
    if (task.endTime !== undefined) meta.push(formatDuration(task.endTime - task.startTime));
    if (task.triggerOnCompletion) meta.push("agent woken");
  }
  return lines((w) => {
    const out = [head(theme, task, meta.join(" · "), w)];
    if (!expanded) return out;
    out.push(commandLine(theme, task, w));
    if (task.error) out.push(truncateToWidth(theme.fg("error", `  ${task.error}`), w, "…"));
    const tail = task.outputTail ?? [];
    for (const line of tail) out.push(truncateToWidth(theme.fg("toolOutput", `  ${line}`), w, "…"));
    out.push(truncateToWidth(theme.fg("dim", `  ${task.outputPath}`), w, "…"));
    out.push(truncateToWidth(theme.fg("dim", `  (${task.id})`), w, "…"));
    return out;
  });
}
