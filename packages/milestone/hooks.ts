/**
 * @pi-unipi/milestone — Lifecycle hooks
 *
 * Agent start: append milestone progress as a hidden, persistent context snapshot.
 * Session end: auto-sync completed items from workflow docs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildSessionContext,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { MILESTONE_DIRS, UNIPI_EVENTS, safeMtimeMs, tryRead } from "@pi-unipi/core";
import { getProgressSummary, updateItemStatus } from "./milestone.js";

export const MILESTONE_SNAPSHOT_TYPE = "unipi-milestone-snapshot";

interface MilestoneSnapshotDetails {
  active: boolean;
  workspace: string;
}

interface EffectiveSnapshot {
  content: unknown;
  details?: MilestoneSnapshotDetails;
}

/** Format the active milestone progress included in a snapshot. */
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

/** Build an append-only snapshot that explicitly invalidates earlier snapshots. */
function formatMilestoneSnapshot(workspace: string, context: string | null): string {
  return [
    "# UniPi Milestone Snapshot",
    "This snapshot supersedes all prior UniPi milestone snapshots; use only this snapshot for milestone status.",
    `Workspace: ${workspace}`,
    `Status: ${context ? "active" : "inactive"}`,
    context ?? "No milestones are active for this workspace.",
  ].join("\n\n");
}

function latestEffectiveSnapshot(branch: SessionEntry[]): EffectiveSnapshot | undefined {
  const messages = buildSessionContext(branch).messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "custom" && message.customType === MILESTONE_SNAPSHOT_TYPE) {
      return {
        content: message.content,
        details: message.details as MilestoneSnapshotDetails | undefined,
      };
    }
  }
  return undefined;
}

/** Find state that may have been folded into a compaction summary. */
function latestHistoricalSnapshot(branch: SessionEntry[]): EffectiveSnapshot | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom_message" && entry.customType === MILESTONE_SNAPSHOT_TYPE) {
      return {
        content: entry.content,
        details: entry.details as MilestoneSnapshotDetails | undefined,
      };
    }
  }
  return undefined;
}

function isActiveSnapshot(snapshot: EffectiveSnapshot): boolean {
  if (typeof snapshot.details?.active === "boolean") return snapshot.details.active;
  return typeof snapshot.content === "string" && snapshot.content.includes("Status: active");
}

/**
 * Register the agent-start hook. Snapshots are hidden from the transcript but
 * persist in the append-only session and therefore keep the system prefix stable.
 */
export function registerSessionStartHook(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (_event, ctx) => {
    const workspace = ctx.cwd;
    const milestonesPath = path.join(workspace, MILESTONE_DIRS.MILESTONES);
    const context = formatMilestoneContext(milestonesPath);
    const branch = ctx.sessionManager.getBranch();
    const latest = latestEffectiveSnapshot(branch);
    const historical = latestHistoricalSnapshot(branch);

    // A genuinely clean workspace/session needs no synthetic context. Raw
    // history is checked because compaction may have folded an old active
    // snapshot into summary prose while removing its custom-message identity.
    if (!context && !latest && !historical) return undefined;

    const prior = latest ?? historical;
    if (!context && prior && !isActiveSnapshot(prior)) return undefined;

    const content = formatMilestoneSnapshot(workspace, context);
    if (latest?.content === content) return undefined;

    return {
      message: {
        customType: MILESTONE_SNAPSHOT_TYPE,
        content,
        display: false,
        details: {
          active: context !== null,
          workspace,
        } satisfies MilestoneSnapshotDetails,
      },
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
  // Capture the session workspace because process.cwd() can change before shutdown.
  const baselineSnapshots = new Map<string, string>();
  let sessionStartMs = 0;
  let sessionWorkspace: string | null = null;

  // Capture baselines on session start
  pi.on("session_start", (_event, ctx) => {
    sessionStartMs = Date.now();
    sessionWorkspace = ctx.cwd;
    baselineSnapshots.clear();

    const scanDirs = [
      path.join(sessionWorkspace, ".unipi/docs/specs"),
      path.join(sessionWorkspace, ".unipi/docs/plans"),
      path.join(sessionWorkspace, ".unipi/docs/quick-work"),
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

  const syncModifiedDocs = () => {
    if (!sessionWorkspace) return;

    const milestonesPath = path.join(sessionWorkspace, MILESTONE_DIRS.MILESTONES);
    if (!fs.existsSync(milestonesPath)) return;

    const scanDirs = [
      path.join(sessionWorkspace, ".unipi/docs/specs"),
      path.join(sessionWorkspace, ".unipi/docs/plans"),
      path.join(sessionWorkspace, ".unipi/docs/quick-work"),
    ];

    const modifiedFiles = scanModifiedDocs(scanDirs, sessionStartMs);

    for (const filePath of modifiedFiles) {
      const baseline = baselineSnapshots.get(filePath);
      if (!baseline) continue;

      const completions = extractNewCompletions(filePath, baseline);
      for (const { text, phase } of completions) {
        // Try exact match update — silently skip items that don't match
        // milestones (e.g. internal spec checklists with " — covered in Task N" suffixes)
        updateItemStatus(milestonesPath, phase, text, true);
      }
    }
  };

  // Workflow emits this once its follow-up agent loop drains.
  pi.events.on(UNIPI_EVENTS.WORKFLOW_END, syncModifiedDocs);

  // Final fallback for changes made outside a workflow or before event wiring.
  pi.on("session_shutdown", syncModifiedDocs);
}
