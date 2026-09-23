/**
 * @pi-unipi/workflow — Plan mode + permission modes
 *
 * Formerly the workflow command suite (brainstorm/plan/work/…); those twenty
 * slash commands and their skill-dispatch sandboxes were removed in favor of
 * two orthogonal, always-on mechanisms:
 *
 *   - permission modes (ask | auto | full) gate every tool call, with jev
 *     judging ambiguous bash in auto mode;
 *   - plan mode (/unipi:plan, Alt+P) makes a session read-only except for its
 *     plan file.
 *
 * The bundled skills moved to @pi-unipi/skill-registry.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  MODULES,
  UNIPI_EVENTS,
  emitEvent,
  getPackageVersion,
  initUnipiDirs,
} from "@pi-unipi/core";
import { createPermissionController, registerPermissionModes } from "./src/permission/index.js";
import { enforcePlanMode } from "./src/plan/enforce.js";
import { currentPlanState, registerPlanMode } from "./src/plan/index.js";

/** Package version (read from package.json at load time) */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Tool-call fields the gates need: bash command, write/edit path, args summary. */
export function describeToolCall(event: ToolCallEvent): { toolName: string; subject: string } {
  const input = (event as { input?: Record<string, unknown> }).input ?? {};
  const toolName = event.toolName;
  if (toolName === "bash" || toolName === "powershell") {
    return { toolName, subject: typeof input.command === "string" ? input.command : "" };
  }
  if (toolName === "write" || toolName === "edit") {
    return { toolName, subject: typeof input.path === "string" ? input.path : "" };
  }
  let summary = "";
  try {
    summary = JSON.stringify(input) ?? "";
  } catch {
    summary = "";
  }
  return { toolName, subject: summary.slice(0, 300) };
}

function summaryOf(input: { toolName: string; subject: string }): string {
  return input.subject.replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
  const permission = createPermissionController(pi);

  registerPermissionModes(pi, permission);
  registerPlanMode(pi);

  // Every tool call: plan-mode enforcement first, then the permission gate.
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    const input = describeToolCall(event);

    const planBlock = enforcePlanMode(input, currentPlanState(ctx.sessionManager.getSessionId()), ctx.cwd);
    if (planBlock) return planBlock;

    const decision = await permission.decide(input, ctx);
    if (decision.action === "allow") return undefined;
    if (decision.action === "block") return { block: true, reason: decision.reason };

    const outcome = await permission.approve(
      {
        toolName: input.toolName,
        summary: summaryOf(input),
        reason: decision.reason,
        subject: decision.subject,
      },
      ctx,
    );
    return outcome.block ? { block: true, reason: outcome.reason } : undefined;
  });

  // Announce module presence on session start.
  pi.on("session_start", async (_event, ctx) => {
    initUnipiDirs();

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.WORKFLOW,
      version: VERSION,
      commands: ["unipi:plan", "unipi:permission"],
      tools: ["plan_submit"],
    });

    ctx.ui.setStatus("unipi-workflow", undefined);
  });
}
