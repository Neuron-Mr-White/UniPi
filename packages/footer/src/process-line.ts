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
import { pendingWorkLabel, WORKING_TITLE } from "@pi-unipi/core";

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
  // One column can never host a meaningful one-liner, and any content would
  // be exactly-full-width (issue #31 wrap desync) — render nothing.
  if (width <= 1) return [];
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
  // One column short of the terminal (issue #31 — same wrap desync as the
  // glance frame; see glanceFrameWidth() in glance-editor.ts).
  if (w >= width) return [truncateToWidth(line, Math.max(1, width - 1))];
  const leftPad = Math.floor((width - w) / 2);
  return [" ".repeat(leftPad) + line];
}

/** pi's own working spinner frames (pi-tui Loader default). */
export const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface WorkingLineStyle {
  /** Colours the spinner frame (accent). */
  spinner?: (text: string) => string;
  /** Colours the detail text (muted). */
  muted?: (text: string) => string;
  /** Spinner frame index (animated by the caller). */
  frame?: number;
  /** Elapsed ms since the pending work was first seen idle. */
  elapsedMs?: number;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return `${String(m)}m ${String(s % 60)}s`;
}

/**
 * UNI-162 / UNI-221: while pi is idle but a wait source still has a reason
 * (a background subagent running, a bg task that will wake the agent, a
 * non-blocking fusion handoff in flight) the pane must not read as finished.
 * Renders a working line shaped like pi's own ("⠋ Working… · bg: npm test ·
 * 12s") read straight off the arbiter's wait sources via core's
 * `pendingWorkLabel()` (whichever package registered the wait source is the
 * source of truth).
 *
 * Returns `undefined` when pi is busy (pi shows its own working line) or
 * nothing is pending (callers show their normal idle state).
 */
export function renderWaitingLine(width: number, isIdle: () => boolean, style: WorkingLineStyle = {}): string | undefined {
  if (width <= 1) return undefined;
  let idle: boolean;
  try {
    idle = isIdle();
  } catch {
    idle = true;
  }
  if (!idle) return undefined;
  const label = pendingWorkLabel();
  if (label === null) return undefined;
  const spinner = style.spinner ?? ((t: string) => t);
  const muted = style.muted ?? ((t: string) => t);
  const frame = WORKING_FRAMES[Math.abs(style.frame ?? 0) % WORKING_FRAMES.length] ?? WORKING_FRAMES[0];
  const elapsed = style.elapsedMs !== undefined ? ` · ${formatElapsed(style.elapsedMs)}` : "";
  const line = ` ${spinner(frame)} ${spinner(WORKING_TITLE)}${muted(` · ${label}${elapsed}`)}`;
  return truncateToWidth(line, Math.max(1, width - 1));
}
