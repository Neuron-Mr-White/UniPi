/**
 * Plan mode — plan with the user, then ask for approval before implementation.
 *
 * Investigation stays open (reads, research, read-only shell); the harness only
 * blocks writes outside the plan file, `docs/plans/` and the temp dir, and asks
 * before state-changing shell. State lives in a pi custom entry (`unipi:plan-mode`)
 * so a resume keeps it, and the mode's rules reach the model as appended messages
 * (never the system prompt) so the provider prefix cache stays intact.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_EVENTS, emitEvent, harnessMetadata, registerCommandRunner, sendHarnessUserMessage } from "@pi-unipi/core";
import { updateWorkflowStatus } from "../status.js";
import {
  PLAN_MESSAGE_TYPE,
  PLAN_STATE_ENTRY,
  activePlanFile,
  currentPlanState,
  displayPlanPath,
  resetPlanState,
  restorePlanState,
} from "./state.js";
import { renderPlanReview, type ReviewChoice } from "./review.js";

export { currentPlanState } from "./state.js";

export const PLAN_TOOL = "plan_submit";

const APPROVE = "Approve & implement";
const KEEP = "Keep planning…";
const DISCARD = "Discard plan";

export function planInstructions(planPath: string): string {
  return [
    "Plan mode is ON — plan with the user, do not implement.",
    "Investigate freely: read, search, research, read-only shell, run existing tests/builds to learn current behaviour, delegate research-only tasks. Do not edit source files, change git state, install packages, or send/publish anything. The harness blocks writes outside the plan file, docs/plans/ and temp dirs, and asks the user before state-changing shell. If something is denied, take another route; after two denials, record the uncertainty in the plan.",
    "Clarifying is part of planning: when a decision that shapes the plan cannot be settled from evidence (a real trade-off or a user preference), ask the user with ask_user instead of guessing. Keep planning across turns until every such question is answered. Do not call plan_submit in the same turn you first draft the plan unless nothing is left to ask.",
    `Write the plan to ${planPath} with exactly these two top-level sections:`,
    "## Summary",
    "For the human approving it. One-sentence answer first (no heading above it inside the section), then short numbered points: what changes and why, what the user will notice, decisions or risks that need them. Product level, plain words, at most three code names, no file lists or line numbers. 5–15 lines.",
    "## Implementation",
    'For whoever implements it: ### Steps, ### Files, ### Risks, ### Verification, ### Open questions (write "None" when nothing is open).',
    'Call plan_submit only when ### Open questions is "None" and the user has had the chance to settle every shaping decision. plan_submit refuses while open questions remain.',
  ].join("\n");
}

export function planReminder(planPath: string): string {
  return [
    `[plan mode on — plan file ${planPath}]`,
    "Investigate freely; no source edits, git state changes, installs or publishing.",
    "Settle shaping decisions with ask_user; keep planning until they are answered.",
    'Call plan_submit only when ### Open questions says "None".',
  ].join("\n");
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

/** sha1 of the plan content — the keep-planning gate compares these. */
export function planContentHash(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

const OPEN_QUESTIONS_HEADING = /^#{2,3}\s+open questions:?\s*$/i;
const LIST_MARKER = /^(?:[-*•]|\d+[.)])\s+/;
const NONE_ITEM = /^(none|n\/a|-)\.?$/i;

/**
 * The items under `## Open questions` / `### Open questions` (case-insensitive),
 * with bullet/number markers stripped and "None"-style lines dropped. Collection
 * stops at the next heading line; a missing heading → [] so old-format plans are
 * not blocked.
 */
export function openQuestions(plan: string): string[] {
  const lines = plan.split("\n");
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (OPEN_QUESTIONS_HEADING.test(lines[index]!)) {
      start = index;
      break;
    }
  }
  if (start === -1) return [];

  const items: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("#")) break;
    const text = lines[index]!.trim().replace(LIST_MARKER, "").trim();
    if (!text || NONE_ITEM.test(text)) continue;
    items.push(text);
  }
  return items;
}

/** The plan_submit refusal for this plan, or null when it may go to approval. */
export function planSubmitRefusal(content: string, lastKeptHash: string | null): string | null {
  const open = openQuestions(content);
  if (open.length > 0) {
    return (
      `Open questions remain:\n${open.map((question) => `- ${question}`).join("\n")}\n` +
      "Settle them with ask_user first, or move items that can safely wait to ### Risks."
    );
  }
  if (lastKeptHash && planContentHash(content) === lastKeptHash) {
    return 'The plan has not changed since the user chose "Keep planning". Revise the plan (or ask_user about the feedback) before submitting again.';
  }
  return null;
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

  const choice = await askForDecision(ctx, content, displayPlanPath(ctx.cwd, state.planFile));

  if (choice === KEEP) {
    const feedback = await ctx.ui.input("What should change in the plan?", "");
    state.lastKeptHash = planContentHash(content);
    return { status: "keep", feedback: feedback?.trim() || undefined };
  }

  if (choice !== APPROVE && choice !== DISCARD) {
    // Esc (undefined) keeps planning rather than silently dropping the session.
    state.lastKeptHash = planContentHash(content);
    return { status: "keep", feedback: undefined };
  }

  if (choice === DISCARD) {
    disablePlanMode(pi, ctx, "discarded");
    return { status: "discarded" };
  }

  disablePlanMode(pi, ctx, "approved");
  sendHarnessUserMessage(
    pi,
    `Implement the approved plan below. Treat it as authoritative; do not re-plan.\n\n${content}`,
    { source: "Plan mode", title: "Approved plan", synopsis: "Plan approved — implementation handoff" },
    { deliverAs: "followUp" },
  );
  return { status: "approved" };
}

/**
 * Show the plan itself and ask what to do with it. The review overlay renders the
 * plan as markdown with the three decisions under it; a UI without custom
 * components (RPC, tests) falls back to the plain select.
 */
async function askForDecision(
  ctx: ExtensionContext | ExtensionCommandContext,
  plan: string,
  path: string,
): Promise<string | undefined> {
  const ui = ctx.ui as typeof ctx.ui & { custom?: (...args: unknown[]) => Promise<unknown> };
  if (typeof ui.custom === "function") {
    try {
      const picked = (await ui.custom(renderPlanReview({ plan, path }), {
        overlay: true,
        overlayOptions: { width: "90%", minWidth: 60, maxHeight: "92%", anchor: "center", margin: 1 },
      })) as ReviewChoice | null | undefined;
      if (picked === "approve") return APPROVE;
      if (picked === "keep") return KEEP;
      if (picked === "discard") return DISCARD;
      return undefined; // Esc
    } catch {
      // A UI that cannot host the overlay → plain select below.
    }
  }
  return ctx.ui.select(`Plan ready (${path}) — what next?`, [APPROVE, KEEP, DISCARD]);
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
  updateWorkflowStatus({ planMode: true });
  emitEvent(pi, UNIPI_EVENTS.PLAN_MODE_CHANGED, {
    active: true,
    planFile: displayPlanPath(ctx.cwd, planFile),
  });
  pi.sendMessage({
    customType: PLAN_MESSAGE_TYPE,
    content: planInstructions(displayPlanPath(ctx.cwd, planFile)),
    display: true,
    details: { unipiHarness: harnessMetadata({ source: "Plan mode", title: "Plan mode on", synopsis: "Plan with the user — plan file required" }, "direct") },
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
  state.lastKeptHash = null;

  pi.appendEntry(PLAN_STATE_ENTRY, { active: false, planFile });
  updateWorkflowStatus({ planMode: false });
  emitEvent(pi, UNIPI_EVENTS.PLAN_MODE_CHANGED, {
    active: false,
    planFile: displayPlanPath(ctx.cwd, planFile),
    reason,
  });
  if (reason !== "approved") {
    const note = reason === "discarded" ? "[plan mode off — plan discarded]" : "[plan mode off]";
    pi.sendMessage({
      customType: PLAN_MESSAGE_TYPE,
      content: note,
      display: true,
      details: { unipiHarness: harnessMetadata({ source: "Plan mode", title: reason === "discarded" ? "Plan discarded" : "Plan mode off" }, "direct") },
    });
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
    description: "Plan mode — plan with the user, then approve a plan",
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
      "Plan mode only: submit the finished plan in <plan file> for approval, after every shaping question is settled with the user. " +
      "Refused while ### Open questions lists items or when the plan is unchanged since the user asked to keep planning.",
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
      const refusal = planSubmitRefusal(content, state.lastKeptHash);
      if (refusal) {
        return { content: [{ type: "text", text: refusal }], isError: true, details: {} };
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
        return { content: [{ type: "text", text: "Plan approved." }], details: {}, terminate: true };
      }
      if (result.status === "discarded") {
        return { content: [{ type: "text", text: "Plan discarded; plan mode is off." }], details: {}, terminate: true };
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
    updateWorkflowStatus({ planMode: state.active });
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
        details: { unipiHarness: harnessMetadata({ source: "Plan mode", title: "Plan reminder (hidden)" }, "before_agent_start") },
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
