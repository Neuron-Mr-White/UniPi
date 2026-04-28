/**
 * @pi-unipi/milestone — Coexist triggers
 *
 * Hooks into workflow skill completions to offer milestone integration.
 * Non-blocking — if MILESTONES.md doesn't exist, triggers silently skip.
 */

import * as path from "node:path";
import { MILESTONE_DIRS, tryRead } from "@pi-unipi/core";
import { parseMilestones, updateItemStatus, writeMilestones } from "./milestone.js";
import type { MilestoneDoc } from "./types.js";

/**
 * After brainstorm completes: check if new spec items map to milestones.
 * Offers to mark matching items as planned.
 */
export function onBrainstormComplete(specPath: string): void {
  const cwd = process.cwd();
  const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);

  // Silently skip if no MILESTONES.md
  if (!tryRead(milestonesPath)) return;

  const specContent = tryRead(specPath);
  if (!specContent) return;

  // Extract checklist items from the new spec
  const specItems: string[] = [];
  for (const line of specContent.split("\n")) {
    const match = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (match) {
      specItems.push(match[2].trim().toLowerCase());
    }
  }

  if (specItems.length === 0) return;

  // Check against milestones
  const doc = parseMilestones(milestonesPath);
  const matched: string[] = [];

  for (const phase of doc.phases) {
    for (const item of phase.items) {
      const normalized = item.text.toLowerCase().trim();
      if (specItems.includes(normalized) && !item.checked) {
        matched.push(`"${item.text}" in ${phase.name}`);
      }
    }
  }

  if (matched.length > 0) {
    // Removed console.log — milestone matches are informational.
    // Use /unipi:milestone-update to sync manually.
  }
}

/**
 * After plan completes: check if plan tasks map to milestone items.
 * Logs matching items for awareness.
 */
export function onPlanComplete(planPath: string): void {
  const cwd = process.cwd();
  const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);

  // Silently skip if no MILESTONES.md
  if (!tryRead(milestonesPath)) return;

  const planContent = tryRead(planPath);
  if (!planContent) return;

  // Extract task names from plan (### Task N — Name pattern)
  const planTasks: string[] = [];
  for (const line of planContent.split("\n")) {
    const match = line.match(/^###\s+Task\s+\d+\s*[—–-]\s*(.+)$/);
    if (match) {
      planTasks.push(match[1].trim().toLowerCase());
    }
  }

  if (planTasks.length === 0) return;

  // Check against milestones
  const doc = parseMilestones(milestonesPath);
  const matched: string[] = [];

  for (const phase of doc.phases) {
    for (const item of phase.items) {
      const normalized = item.text.toLowerCase().trim();
      // Check if any plan task contains the milestone item text or vice versa
      for (const task of planTasks) {
        if (task.includes(normalized) || normalized.includes(task)) {
          matched.push(`"${item.text}" → plan task`);
          break;
        }
      }
    }
  }

  if (matched.length > 0) {
    // Removed console.log — plan-milestone matches are informational.
  }
}

/**
 * After consolidate: reference milestone sync that already happened.
 */
export function onConsolidate(): void {
  const cwd = process.cwd();
  const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);

  if (!tryRead(milestonesPath)) return;

  // Removed console.log — milestone auto-sync is silent.
}
