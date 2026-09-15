/**
 * @pi-unipi/background-tasks — tinted chat cards
 *
 * Background-task launch/completion messages were plain single lines that got
 * lost in the transcript. These helpers render them as padded, background-
 * tinted boxes (same visual language as pi's tool cards) so a user scanning
 * the chat can spot "a bg task started here" / "it finished here" at a glance.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import { formatDuration, taskDisplayName, type BgTaskSnapshot } from "./types.js";

type ThemeLike = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

type CardTone = "pending" | "success" | "error";

const BG_FOR_TONE: Record<CardTone, string> = {
  pending: "toolPendingBg",
  success: "toolSuccessBg",
  error: "toolErrorBg",
};

function toneFor(status: BgTaskSnapshot["status"]): CardTone {
  if (status === "running") return "pending";
  if (status === "completed") return "success";
  return "error";
}

function statusGlyph(theme: ThemeLike, status: BgTaskSnapshot["status"]): string {
  if (status === "running") return theme.fg("accent", "●");
  if (status === "completed") return theme.fg("success", "✓");
  if (status === "killed") return theme.fg("warning", "■");
  return theme.fg("error", "✗");
}

function card(theme: ThemeLike, tone: CardTone, lines: string[]): Box {
  const box = new Box(1, 0, (text) => theme.bg(BG_FOR_TONE[tone], text));
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

/** `bg_run` result card: "● bg started <name> (id) · will wake agent" */
export function renderLaunchCard(theme: ThemeLike, task: BgTaskSnapshot): Box {
  const wake = task.triggerOnCompletion
    ? theme.fg("dim", " · wakes agent on completion")
    : task.notifyOnCompletion
      ? theme.fg("dim", " · notifies on completion")
      : theme.fg("dim", " · silent");
  const head = `${statusGlyph(theme, "running")} ${theme.fg("accent", theme.bold("bg started"))} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}${wake}`;
  const cmd = theme.fg("dim", `$ ${task.command.length > 120 ? `${task.command.slice(0, 120)}…` : task.command}`);
  return card(theme, "pending", [head, cmd]);
}

/** Completion notification card: "✓ bg done <name> · exit 0 · 25s" + last output lines */
export function renderCompletionCard(theme: ThemeLike, task: BgTaskSnapshot | undefined): Box {
  if (task === undefined) {
    return card(theme, "success", [`${theme.fg("success", "✓")} ${theme.fg("accent", theme.bold("bg done"))}`]);
  }
  const tone = toneFor(task.status);
  const label =
    task.status === "completed" ? "bg done" : task.status === "killed" ? "bg stopped" : "bg failed";
  const meta: string[] = [];
  if (task.exitCode !== undefined && task.exitCode !== null) meta.push(`exit ${String(task.exitCode)}`);
  if (task.endTime !== undefined) meta.push(formatDuration(task.endTime - task.startTime));
  if (task.triggerOnCompletion) meta.push("agent woken");
  const head = `${statusGlyph(theme, task.status)} ${theme.fg(tone === "error" ? "error" : "success", theme.bold(label))} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}${meta.length > 0 ? theme.fg("dim", ` · ${meta.join(" · ")}`) : ""}`;
  const lines = [head];
  if (task.error) lines.push(theme.fg("error", task.error));
  const tail = task.outputTail ?? [];
  for (const line of tail) lines.push(theme.fg("toolOutput", `  ${line}`));
  lines.push(theme.fg("dim", `  ${task.outputPath}`));
  return card(theme, tone, lines);
}
