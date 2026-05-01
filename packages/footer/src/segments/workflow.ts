/**
 * @pi-unipi/footer — Workflow segments
 *
 * Segment renderers for the workflow group: current_command, sandbox_level,
 * command_duration.
 * Data sourced from WORKFLOW_START/END events via registry cache.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment, SemanticColor } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";



function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getWorkflowData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

/** Map a workflow command name to a semantic color for category differentiation */
function getWorkflowSemanticColor(command: string): SemanticColor {
  const c = command.toLowerCase();

  // Red: brainstorm, debug, gather-context, quick-fix, quick-work, chore-create
  if (c.includes("brainstorm") || c.includes("debug") || c.includes("gather-context") ||
      c.includes("quick-fix") || c.includes("quick-work") || c.includes("chore-create")) {
    return "workflowBrainstorm";
  }

  // Orange: chore-execute, plan
  if (c.includes("chore-exec") || c.includes("plan")) {
    return "workflowChoreExec";
  }

  // Yellow: work
  if (c.includes("work") && !c.includes("network") && !c.includes("framework") && !c.includes("worktree")) {
    return "workflowWork";
  }

  // Green: review-work, review
  if (c.includes("review")) {
    return "workflowReview";
  }

  // Blue: worktree-*
  if (c.includes("worktree")) {
    return "worktree" as SemanticColor;
  }

  // Auto
  if (c.includes("auto")) {
    return "workflowAuto";
  }

  // Default: idle/none
  return "workflowNone";
}

function renderCurrentCommandSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getWorkflowData(ctx);
  const active = data.active === true;
  const command = data.command as string | undefined;

  const workflowIcon = getIcon("currentCommand");

  // No workflow — show dash
  if (!command) {
    const content = withIcon("currentCommand", "-");
    return { content: applyColor("workflow", content, ctx.theme, ctx.colors), visible: true };
  }

  const statusPrefix = active ? "▶" : "✓";
  const semanticColor = getWorkflowSemanticColor(command);
  const content = `${workflowIcon} ${statusPrefix} ${command}`;
  return { content: applyColor(semanticColor, content, ctx.theme, ctx.colors), visible: true };
}

function renderSandboxLevelSegment(ctx: FooterSegmentContext): RenderedSegment {
  const piCtx = ctx.piContext as Record<string, unknown> | undefined;
  // Sandbox level is not directly exposed — show a generic indicator
  const sandboxEnabled = true; // Default assumption
  const content = withIcon("sandboxLevel", sandboxEnabled ? "sandbox" : "full");
  return { content: applyColor("workflow", content, ctx.theme, ctx.colors), visible: true };
}

function renderCommandDurationSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getWorkflowData(ctx);
  const startTime = data.startTime as number | undefined;
  const durationMs = data.durationMs as number | undefined;

  let display: string;
  if (durationMs !== undefined) {
    display = formatDuration(durationMs);
  } else if (startTime) {
    display = formatDuration(Date.now() - startTime);
  } else {
    return { content: "", visible: false };
  }

  const content = withIcon("commandDuration", display);
  return { content: applyColor("workflow", content, ctx.theme, ctx.colors), visible: true };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

export const WORKFLOW_SEGMENTS: FooterSegment[] = [
  { id: "current_command", label: "Command", shortLabel: "wrk", description: "Active workflow command", zone: "left", icon: "", render: renderCurrentCommandSegment, defaultShow: true },
  { id: "sandbox_level", label: "Sandbox", shortLabel: "sbx", description: "Sandbox permission level", zone: "center", icon: "", render: renderSandboxLevelSegment, defaultShow: false },
  { id: "command_duration", label: "Duration", shortLabel: "cdur", description: "Current command duration", zone: "center", icon: "", render: renderCommandDurationSegment, defaultShow: true },
];
