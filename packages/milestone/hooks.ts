/**
 * @pi-unipi/milestone — Lifecycle hooks
 *
 * Session start: inject milestone progress as system context.
 * Session end: auto-sync completed items from workflow docs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MILESTONE_DIRS, safeMtimeMs, tryRead } from "@pi-unipi/core";
import { parseMilestones, getProgressSummary, updateItemStatus } from "./milestone.js";

/** Track when the session started for diffing modified files */
let sessionStartMs = 0;

/**
 * Format a progress summary as a context string for the system prompt.
 */
function formatMilestoneContext(filePath: string): string | null {
  const summary = getProgressSummary(filePath);
  if (summary.totalItems === 0) return null;

  const phaseLines = summary.phases
    .filter((p) => p.total > 0)
    .map((p) => `  ${p.name}: ${p.done}/${p.total} done`);

  const focus = summary.currentPhase
    ? `Current focus: ${summary.currentPhase}`
    : "";

  return [
    "## Project Milestones",
    `Overall progress: ${summary.completedItems}/${summary.totalItems} items (${summary.percentComplete}%)`,
    ...phaseLines,
    focus,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Register session start hook — injects milestone progress into system context.
 */
export function registerSessionStartHook(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    sessionStartMs = Date.now();

    const cwd = process.cwd();
    const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);

    const context = formatMilestoneContext(milestonesPath);
    if (!context) return undefined;

    // Append milestone context to the system prompt
    const currentPrompt = (event as any).systemPrompt ?? "";
    return {
      systemPrompt: currentPrompt + "\n\n" + context,
    };
  });
}

/**
 * Extract checkbox items that changed from [ ] to [x] in a file.
 * Compares current state against a baseline snapshot.
 */
function extractNewCompletions(
  filePath: string,
  baselineContent: string,
): Array<{ text: string; phase: string }> {
  const currentContent = tryRead(filePath);
  if (!currentContent) return [];

  const baselineLines = baselineContent.split("\n");
  const currentLines = currentContent.split("\n");
  const results: Array<{ text: string; phase: string }> = [];
  let currentPhase = "";

  for (let i = 0; i < currentLines.length; i++) {
    const line = currentLines[i];

    // Track phase
    const phaseMatch = line.match(/^##\s+(.+)$/);
    if (phaseMatch) {
      currentPhase = phaseMatch[1].trim();
      continue;
    }

    // Check if this line is a newly checked item
    const currentItemMatch = line.match(/^-\s+\[x\]\s+(.+)$/);
    if (currentItemMatch && currentPhase) {
      // Check if baseline had this as unchecked
      const baselineLine = baselineLines[i] ?? "";
      const baselineItemMatch = baselineLine.match(/^-\s+\[([ xX])\]\s+(.+)$/);
      if (baselineItemMatch && baselineItemMatch[1] === " ") {
        // Same position, was unchecked, now checked
        results.push({ text: currentItemMatch[1].trim(), phase: currentPhase });
      } else if (!baselineItemMatch) {
        // Line didn't exist or wasn't a checkbox — check by text match in same phase
        const text = currentItemMatch[1].trim().toLowerCase();
        const foundUnchecked = baselineLines.some((bl) => {
          const m = bl.match(/^-\s+\[\s\]\s+(.+)$/);
          return m && m[1].trim().toLowerCase() === text;
        });
        if (foundUnchecked) {
          results.push({ text: currentItemMatch[1].trim(), phase: currentPhase });
        }
      }
    }
  }

  return results;
}

/**
 * Scan workflow docs for files modified since session start.
 */
function scanModifiedDocs(dirs: string[], since: number): string[] {
  const modified: string[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      const mtime = safeMtimeMs(filePath);
      if (mtime > since) {
        modified.push(filePath);
      }
    }
  }

  return modified;
}

/**
 * Register session end hook — listens for WORKFLOW_END events,
 * scans modified docs, and auto-updates MILESTONES.md.
 */
export function registerSessionEndHook(pi: ExtensionAPI): void {
  // Store baseline snapshots at session start
  const baselineSnapshots = new Map<string, string>();

  // Capture baselines on session start
  pi.on("session_start", () => {
    sessionStartMs = Date.now();
    baselineSnapshots.clear();

    const cwd = process.cwd();
    const scanDirs = [
      path.join(cwd, ".unipi/docs/specs"),
      path.join(cwd, ".unipi/docs/plans"),
      path.join(cwd, ".unipi/docs/quick-work"),
    ];

    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const content = tryRead(filePath);
        if (content) baselineSnapshots.set(filePath, content);
      }
    }
  });

  // Listen for WORKFLOW_END events
  pi.on("input", (event) => {
    // Check if this is a unipi event emission for WORKFLOW_END
    // The input event fires for tool calls; we need to detect when
    // the workflow ends. We'll use the events system instead.
    return undefined;
  });

  // Use tool_result to detect workflow end
  // Actually, we should listen for the UNIPI_EVENTS.WORKFLOW_END via pi.events
  // But the ExtensionAPI doesn't expose pi.events.on() directly.
  // Instead, we'll hook into session_shutdown to do a final sync.
  pi.on("session_shutdown", () => {
    const cwd = process.cwd();
    const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);

    if (!fs.existsSync(milestonesPath)) return;

    const scanDirs = [
      path.join(cwd, ".unipi/docs/specs"),
      path.join(cwd, ".unipi/docs/plans"),
      path.join(cwd, ".unipi/docs/quick-work"),
    ];

    const modifiedFiles = scanModifiedDocs(scanDirs, sessionStartMs);

    for (const filePath of modifiedFiles) {
      const baseline = baselineSnapshots.get(filePath);
      if (!baseline) continue;

      const completions = extractNewCompletions(filePath, baseline);
      for (const { text, phase } of completions) {
        // Try exact match update
        const updated = updateItemStatus(milestonesPath, phase, text, true);
        if (!updated) {
          console.warn(
            `[milestone] Could not auto-update "${text}" in phase "${phase}" — no exact match found`,
          );
        }
      }
    }
  });
}
