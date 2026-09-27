/**
 * User-only progress bars for long-horizon owners.
 *
 *   ↻ Ralph · docs-cleanup  ████████▒▒░░░░░░░░░░  4/10 items  iteration 3/20
 *   ◎ Goal                  ███████████▒▒░░░░░░░  ~55%  turn 4/30
 *     Parser and CLI flags done; tests for the error paths are left.
 *
 * Ralph counts its checklist. A goal has no countable progress, so a one-off
 * side call (never in the session context) estimates % done + a summary.
 */

import type { ProgressData } from "@pi-unipi/core";
import type { GoalState } from "./engine/goal-state.js";
import type { RalphLoop } from "./engine/ralph.js";

export function ralphProgressData(ralph: Pick<RalphLoop, "get" | "progressSummary">): ProgressData | undefined {
  const st = ralph.get();
  if (!st) return undefined;
  const p = ralph.progressSummary();
  const live = st.status === "active";
  const active = live ? Math.min(st.itemsPerIteration, Math.max(0, p.total - p.checked)) : 0;
  return {
    icon: "↻",
    label: `Ralph · ${st.name}`,
    done: p.checked,
    active,
    total: p.total,
    unit: "items",
    detail: `iteration ${String(st.iteration)}/${String(st.maxIterations)}${live ? "" : ` · ${st.status}`}`,
    summary: live && p.next.length > 0 ? `next: ${p.next.slice(0, 3).join(" · ")}` : undefined,
  };
}

export interface GoalEvidence {
  commands: readonly string[];
  changedFiles: readonly string[];
  recentTail: ReadonlyArray<{ role: string; text: string }>;
}

export function goalEstimatePrompt(goal: Pick<GoalState, "objective" | "turn" | "maxTurns">, evidence: GoalEvidence | undefined, previous: number | undefined): string {
  const lines = [
    "Estimate progress on a goal for a progress bar shown to the user. Be honest and conservative: 100 only when the objective is fully met.",
    "",
    `Objective: ${goal.objective}`,
    `Turn ${String(goal.turn)} of at most ${String(goal.maxTurns)}.`,
  ];
  if (previous !== undefined) lines.push(`Previous estimate: ${String(previous)}%.`);
  if (evidence) {
    if (evidence.changedFiles.length) lines.push(`Files touched recently: ${[...new Set(evidence.changedFiles)].slice(-12).join(", ")}`);
    if (evidence.commands.length) lines.push(`Commands run recently: ${evidence.commands.slice(-8).join(" | ")}`);
    if (evidence.recentTail.length) {
      lines.push("", "Latest messages:");
      for (const m of evidence.recentTail.slice(-4)) lines.push(`[${m.role}] ${m.text.slice(0, 600)}`);
    }
  }
  lines.push("", 'Reply with JSON only: {"percent": <integer 0-100>, "summary": "<one or two short sentences: what is done, what is left>"}');
  return lines.join("\n");
}

/** Pull `{percent, summary}` out of a model reply (tolerates fences and prose). */
export function parseEstimate(text: string): { percent: number; summary: string } | undefined {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[0]) as { percent?: unknown; summary?: unknown };
    const n = typeof raw.percent === "number" ? raw.percent : Number(raw.percent);
    if (!Number.isFinite(n)) return undefined;
    return { percent: Math.max(0, Math.min(100, Math.round(n))), summary: typeof raw.summary === "string" ? raw.summary.trim() : "" };
  } catch {
    return undefined;
  }
}

/** Shade = the slice in progress; a live goal always shows one. */
export function goalProgressData(goal: Pick<GoalState, "turn" | "maxTurns" | "status">, percent: number, summary: string): ProgressData {
  const live = goal.status === "active" || goal.status === "waiting";
  return {
    icon: "◎",
    label: "Goal",
    done: goal.status === "complete" ? 100 : percent,
    active: live ? Math.max(1, Math.min(10, 100 - percent)) : 0,
    total: 100,
    estimated: goal.status !== "complete",
    detail: `turn ${String(goal.turn)}/${String(goal.maxTurns)}${live ? "" : ` · ${goal.status}`}`,
    summary: summary || undefined,
  };
}
