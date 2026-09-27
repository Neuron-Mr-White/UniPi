/**
 * Board progress bar (user-only entry):
 *   ▣ Board · unipi  ██████████▒▒░░░░░░░░  5/10 tasks  1 blocked
 * Solid = in review + done, shade = in progress, light = todo + blocked.
 * Backlog, cancelled and archived tasks are outside the bar.
 */

import type { ProgressData } from "@pi-unipi/core";

const COUNTED = new Set(["todo", "in_progress", "in_review", "done", "blocked"]);

export function boardProgressData(tasks: ReadonlyArray<{ status: string }>, slug: string): ProgressData | undefined {
  const counted = tasks.filter((t) => COUNTED.has(t.status));
  if (counted.length === 0) return undefined;
  const n = (s: string) => counted.filter((t) => t.status === s).length;
  const blocked = n("blocked");
  return {
    icon: "▣",
    label: slug ? `Board · ${slug}` : "Board",
    done: n("in_review") + n("done"),
    active: n("in_progress"),
    total: counted.length,
    unit: "tasks",
    detail: blocked > 0 ? `${String(blocked)} blocked` : undefined,
    color: "success",
  };
}
