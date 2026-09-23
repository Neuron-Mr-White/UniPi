/**
 * Plan mode — a read-only session that writes one plan file and then asks for
 * approval before implementation.
 *
 * State lives in a pi custom entry (`unipi:plan-mode`) so a resume keeps it, and
 * the mode's rules reach the model as appended messages (never the system
 * prompt) so the provider prefix cache stays intact.
 */

import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_EVENTS, emitEvent, registerCommandRunner, setSharedPlanMode } from "@pi-unipi/core";
import {
  PLAN_MESSAGE_TYPE,
  PLAN_STATE_ENTRY,
  activePlanFile,
  currentPlanState,
  displayPlanPath,
  resetPlanState,
  restorePlanState,
} from "./state.js";

export { currentPlanState } from "./state.js";

export const PLAN_TOOL = "plan_submit";

const APPROVE = "Approve & implement";
const KEEP = "Keep planning…";
const DISCARD = "Discard plan";

const PLAN_TEMPLATE = ["## Summary", "## Steps", "## Files", "## Risks", "## Verification"];

export function planInstructions(planPath: string): string {
  return [
    "Plan mode is ON — investigation only, no implementation.",
    `The ONLY file you may write or edit is ${planPath}.`,
    "Bash is limited to read-only commands; every mutating tool is refused.",
    "Investigate the codebase, then write the plan to that file. It must start with:",
    PLAN_TEMPLATE.join("\n"),
    `When the plan is written, call ${PLAN_TOOL} to ask for approval.`,
  ].join("\n");
}

export function planReminder(planPath: string): string {
  return `[plan mode: read-only · plan file ${planPath} · call ${PLAN_TOOL} when ready]`;
}

function sessionId(ctx: ExtensionContext | ExtensionCommandContext): string {
  return ctx.sessionManager.getSessionId();
}

function readPlanFile(planFile: string | null): string | null {
  if (!planFile || !existsSync(planFile)) return null;
  const content = readFileSync(planFile, "utf-8").trim();
  return content.length > 0 ? content : null;
}

export interface PlanApprovalResult {
  status: "approved" | "keep" | "discarded";
  feedback?: string;
}

/** The approval prompt, shared by the tool, `/unipi:plan approve` and `view`. */
export async function approvePlan(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  sessionIdValue: string,
): Promise<PlanApprovalResult> {
  const state = currentPlanState(sessionIdValue);
  const content = readPlanFile(state.planFile);
  if (!content) {
    return { status: "keep", feedback: "The plan file is empty — write the plan first." };
  }

  const choice = await ctx.ui.select("Plan ready — what next?", [APPROVE, KEEP, DISCARD]);

  if (choice === KEEP) {
    const feedback = await ctx.ui.input("What should change in the plan?", "");
    return { status: "keep", feedback: feedback?.trim() || undefined };
  }

  if (choice !== APPROVE && choice !== DISCARD) {
    // Esc (undefined) keeps planning rather than silently dropping the session.
    return { status: "keep", feedback: undefined };
  }

  if (choice === DISCARD) {
    disablePlanMode(pi, ctx, "discarded");
    return { status: "discarded" };
  }

  disablePlanMode(pi, ctx, "approved");
  pi.sendUserMessage(
    `Implement the approved plan below. Treat it as authoritative; do not re-plan.\n\n${content}`,
    { deliverAs: "followUp" },
  );
  return { status: "approved" };
}

export function enablePlanMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
): string {
  const id = sessionId(ctx);
  const planFile = activePlanFile(ctx.cwd, id);
  const state = currentPlanState(id);
  state.active = true;
  state.planFile = planFile;

  pi.appendEntry(PLAN_STATE_ENTRY, { active: true, planFile });
  setSharedPlanMode(true);
  emitEvent(pi, UNIPI_EVENTS.PLAN_MODE_CHANGED, {
    active: true,
    planFile: displayPlanPath(ctx.cwd, planFile),
  });
  pi.sendMessage({
    customType: PLAN_MESSAGE_TYPE,
    content: planInstructions(displayPlanPath(ctx.cwd, planFile)),
    display: true,
  });
  ctx.ui.notify(`Plan mode on — plan file ${displayPlanPath(ctx.cwd, planFile)}`, "info");
  return planFile;
}

export function disablePlanMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext,
  reason: "toggled" | "approved" | "discarded" = "toggled",
): void {
  const id = sessionId(ctx);
  const state = currentPlanState(id);
  if (!state.active) return;
  const planFile = state.planFile;
  state.active = false;

  pi.appendEntry(PLAN_STATE_ENTRY, { active: false, planFile });
  setSharedPlanMode(false);
  emitEvent(pi, UNIPI_EVENTS.PLAN_MODE_CHANGED, {
    active: false,
    planFile: displayPlanPath(ctx.cwd, planFile),
    reason,
  });
  if (reason !== "approved") {
    const note = reason === "discarded" ? "[plan mode off — plan discarded]" : "[plan mode off]";
    pi.sendMessage({ customType: PLAN_MESSAGE_TYPE, content: note, display: true });
  }
  ctx.ui.notify(
    reason === "discarded" ? "Plan mode off — plan discarded" : "Plan mode off",
    "info",
  );
}

function showPlan(ctx: ExtensionContext | ExtensionCommandContext, planFile: string | null): void {
  const content = readPlanFile(planFile);
  const path = displayPlanPath(ctx.cwd, planFile);
  if (!content) {
    ctx.ui.notify(`No plan yet at ${path}`, "warning");
    return;
  }
  const clipped = content.length > 1500 ? `${content.slice(0, 1500)}\n…` : content;
  ctx.ui.notify(`${path}\n\n${clipped}`, "info");
}

export function registerPlanMode(pi: ExtensionAPI): void {
  pi.registerCommand("unipi:plan", {
    description: "Plan mode — investigate read-only, then approve a plan",
    getArgumentCompletions: (prefix: string) => {
      const needle = (prefix ?? "").trim().toLowerCase();
      const options = [
        { value: "on", label: "on", description: "Enter plan mode" },
        { value: "off", label: "off", description: "Leave plan mode" },
        { value: "view", label: "view", description: "Show the current plan file" },
        { value: "approve", label: "approve", description: "Run the plan approval prompt" },
      ];
      const matches = options.filter((option) => option.value.startsWith(needle));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const id = sessionId(ctx);
      const state = currentPlanState(id);
      const action = (args ?? "").trim().toLowerCase();

      if (action === "view") {
        showPlan(ctx, state.planFile);
        return;
      }
      if (action === "approve") {
        const result = await approvePlan(pi, ctx, id);
        if (result.status === "keep") {
          ctx.ui.notify(result.feedback ?? "Plan not approved", "warning");
        }
        return;
      }
      if (action === "on") {
        if (!state.active) enablePlanMode(pi, ctx);
        else ctx.ui.notify("Plan mode is already on", "info");
        return;
      }
      if (action === "off") {
        if (state.active) disablePlanMode(pi, ctx);
        else ctx.ui.notify("Plan mode is already off", "info");
        return;
      }
      if (action.length > 0) {
        ctx.ui.notify(`Unknown plan argument "${action}" — use on, off, view or approve`, "warning");
        return;
      }

      // No argument toggles.
      if (state.active) disablePlanMode(pi, ctx);
      else enablePlanMode(pi, ctx);
    },
  });

  pi.registerShortcut("alt+p" as never, {
    description: "Toggle plan mode",
    handler: async (ctx) => {
      const id = sessionId(ctx);
      if (currentPlanState(id).active) disablePlanMode(pi, ctx);
      else enablePlanMode(pi, ctx);
    },
  });

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Submit Plan",
    description:
      "Plan mode only: submit the plan you wrote to <plan file> for approval. " +
      "The user can approve & implement, ask for changes, or discard it.",
    promptSnippet: "Submit the plan for approval (plan mode only).",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const id = sessionId(ctx);
      const state = currentPlanState(id);
      if (!state.active) {
        return {
          content: [{ type: "text", text: "plan_submit is only available in plan mode." }],
          isError: true,
          details: {},
        };
      }
      const content = readPlanFile(state.planFile);
      if (!content) {
        return {
          content: [
            {
              type: "text",
              text: `No plan written yet — write it to ${displayPlanPath(ctx.cwd, state.planFile)} first.`,
            },
          ],
          isError: true,
          details: {},
        };
      }
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "plan_submit needs an interactive session for approval." }],
          isError: true,
          details: {},
        };
      }

      const result = await approvePlan(pi, ctx, id);
      if (result.status === "approved") {
        return { content: [{ type: "text", text: "Plan approved." }], details: {} };
      }
      if (result.status === "discarded") {
        return { content: [{ type: "text", text: "Plan discarded; plan mode is off." }], details: {} };
      }
      return {
        content: [
          {
            type: "text",
            text: `Not approved yet — keep planning.${result.feedback ? `\nFeedback: ${result.feedback}` : ""}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = restorePlanState(sessionId(ctx), ctx.sessionManager.getEntries(), ctx.cwd);
    // Re-announce on resume so the footer shows PLAN without a fresh toggle.
    setSharedPlanMode(state.active);
    emitEvent(pi, UNIPI_EVENTS.PLAN_MODE_CHANGED, {
      active: state.active,
      planFile: displayPlanPath(ctx.cwd, state.planFile),
    });
  });

  // Append-only per-turn reminder while plan mode is active.
  pi.on("before_agent_start", async (_event, ctx) => {
    const id = sessionId(ctx);
    const state = currentPlanState(id);
    if (!state.active) return undefined;
    return {
      message: {
        customType: PLAN_MESSAGE_TYPE,
        content: planReminder(displayPlanPath(ctx.cwd, state.planFile)),
        display: false,
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetPlanState(sessionId(ctx));
  });

  // Hub action (no dedicated row yet): clearing plan mode from the settings hub.
  registerCommandRunner("unipi:plan-off", async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    if (!context) return;
    disablePlanMode(pi, context);
  });

  // Cross-module entry points (kanboard's runner drives plan mode through these,
  // so it needs no dependency on this package).
  registerCommandRunner("unipi:plan-enter", async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    if (!context) return { ok: false, reason: "no context" };
    if (currentPlanState(sessionId(context)).active) return { ok: true, alreadyActive: true };
    const planFile = enablePlanMode(pi, context);
    return { ok: true, planFile };
  });

  registerCommandRunner("unipi:plan-exit", async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    if (!context) return { ok: false, reason: "no context" };
    disablePlanMode(pi, context);
    return { ok: true };
  });
}
