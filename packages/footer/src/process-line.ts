/**
 * @pi-unipi/footer — Background process one-liner
 *
 * Glance-mode strip rendered above the footer frame: one colored dot + count
 * per background-task status. Reads DIRECTLY from the
 * @pi-unipi/background-tasks shared registry (no events, no polling
 * channels); re-renders on the footer's existing 1s refresh timer.
 *
 * Dot → status mapping:
 *   green ● running   yellow ● stopped (killed)   red ● failed   gray ● done (completed)
 *
 * Buckets with zero count are omitted; with nothing in flight the line is
 * empty so the footer stays clean.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getSharedTaskRegistry } from "@pi-unipi/background-tasks";

const GREEN_DOT = "\x1b[38;5;82m●\x1b[0m"; // running — active work
const YELLOW_DOT = "\x1b[38;5;220m●\x1b[0m"; // stopped (killed) — needs attention
const RED_DOT = "\x1b[38;5;196m●\x1b[0m"; // failed — needs attention
const GRAY_DOT = "\x1b[38;5;245m●\x1b[0m"; // done (completed) — idle info

export interface BgProcessCounts {
  running: number;
  stopped: number;
  failed: number;
  done: number;
}

/**
 * Count background tasks by display status straight from the registry.
 * Returns null when background-tasks has not published a registry (module
 * disabled, before first load, or after session shutdown).
 */
export function countBgProcesses(): BgProcessCounts | null {
  try {
    const tasks = getSharedTaskRegistry()?.allTasks();
    if (!tasks) return null;
    const counts: BgProcessCounts = { running: 0, stopped: 0, failed: 0, done: 0 };
    for (const task of tasks) {
      if (task.status === "running") counts.running++;
      else if (task.status === "killed") counts.stopped++;
      else if (task.status === "failed") counts.failed++;
      else if (task.status === "completed") counts.done++;
    }
    return counts;
  } catch {
    return null;
  }
}

/**
 * Render the centered one-liner for the given terminal width.
 * Returns [] when there is nothing to show.
 */
export function renderProcessLine(width: number): string[] {
  if (width <= 0) return [];
  const counts = countBgProcesses();
  if (!counts) return [];

  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${GREEN_DOT} ${counts.running} running`);
  if (counts.stopped > 0) parts.push(`${YELLOW_DOT} ${counts.stopped} stopped`);
  if (counts.failed > 0) parts.push(`${RED_DOT} ${counts.failed} failed`);
  if (counts.done > 0) parts.push(`${GRAY_DOT} ${counts.done} done`);
  if (parts.length === 0) return [];

  const line = parts.join("  ");
  const w = visibleWidth(line);
  if (w >= width) return [truncateToWidth(line, width)];
  const leftPad = Math.floor((width - w) / 2);
  return [" ".repeat(leftPad) + line];
}
