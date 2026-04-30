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

/** Nerd Font icon for workflow:  */
const WORKFLOW_ICON = "\uf52e";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getWorkflowData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

/** Map a workflow command name to a semantic color for slight differentiation */
function getWorkflowSemanticColor(command: string): SemanticColor {
  const commandLower = command.toLowerCase();

  if (commandLower.includes("brainstorm")) return "workflowBrainstorm";
  if (commandLower.includes("plan")) return "workflowPlan";
  if (commandLower.includes("work") && !commandLower.includes("network") && !commandLower.includes("framework")) return "workflowWork";
  if (commandLower.includes("review")) return "workflowReview";
  if (commandLower.includes("auto")) return "workflowAuto";
  if (commandLower.includes("fix") || commandLower.includes("debug")) return "workflowWork";
  if (commandLower.includes("quick")) return "workflowOther";
  if (commandLower.includes("document")) return "workflowPlan";
  if (commandLower.includes("consolidate")) return "workflowOther";

  return "workflow";
}

function renderCurrentCommandSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getWorkflowData(ctx);
  const active = data.active === true;
  const command = data.command as string | undefined;
  if (!command) return { content: "", visible: false };

  const statusPrefix = active ? "▶" : "✓";
  const semanticColor = getWorkflowSemanticColor(command);
  // Use the workflow icon  instead of "wf"
  const content = `${WORKFLOW_ICON} ${statusPrefix} ${command}`;
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
  { id: "current_command", label: "Current Command", icon: "", render: renderCurrentCommandSegment, defaultShow: true },
  { id: "sandbox_level", label: "Sandbox Level", icon: "", render: renderSandboxLevelSegment, defaultShow: false },
  { id: "command_duration", label: "Command Duration", icon: "", render: renderCommandDurationSegment, defaultShow: true },
];
