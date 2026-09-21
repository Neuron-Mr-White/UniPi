/**
 * Long-horizon commands — the explicit mode triggers.
 *
 *   /unipi:goal|ralph|swarm|graph <prompt>   turn override + prompt
 *   /unipi:goal|ralph|swarm|graph status     owner + mode snapshot
 *   /unipi:goal|ralph|swarm|graph resume     reactivate the parked owner
 *   /unipi:goal|ralph|swarm|graph clear      drop the parked owner
 *   /unipi:continue                          resume the parked owner
 *
 * Switching while an owner is active suspends it (max-1 park slot; the
 * coordinator refuses when the slot is held and we surface the message).
 * Design: docs/long-horizon-design.md §3.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";
import type { LhMode } from "./modes.js";
import { MODE_REGISTRY } from "./modes.js";
import type { Gate } from "./gate.js";
import type { OwnerCoordinator } from "./owner.js";
import type { RalphLoop } from "./engine/ralph.js";
import { loadSettings } from "./settings.js";

export interface LongHorizonCommandDeps {
  readonly gate: Gate;
  readonly owner: OwnerCoordinator;
  /** Ralph engine for the /unipi:ralph start surface (optional in tests). */
  readonly ralph?: RalphLoop;
}

function notify(ctx: ExtensionCommandContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
}

function ownerSnapshotText(owner: OwnerCoordinator): string {
  const active = owner.getActive();
  const parked = owner.getParked();
  const history = owner.snapshot().history;
  const lines: string[] = [];
  lines.push(
    active
      ? `Active owner: ${active.kind} "${active.label}" (rev ${active.revision}, lease gen ${active.lease.generation})`
      : "No active owner.",
  );
  lines.push(
    parked
      ? `Parked owner: ${parked.kind} "${parked.label}" (${parked.reason ?? "paused"})`
      : "Park slot: empty.",
  );
  if (history.length > 0) {
    lines.push(`Recent: ${history.slice(0, 3).map((h) => `${h.kind}→${h.terminalReason}`).join(", ")}`);
  }
  return lines.join("\n");
}

/** Short user-facing mode descriptions: use case + cost/success (design §2 rubric). */
const MODE_DESCRIPTIONS = {
  goal: "One objective until verifiably true. Use: medium-complex single deliverables. Cost/success: pareto per success. (<prompt> | status | resume | clear)",
  ralph: "Checklist grind over iterations. Use: enumerable chores, repo-scale plans. Cost/success: low cost, solid success. (start <name> | stop | status | resume | clear | <prompt>)",
  swarm: "Parallel fan-out + one synthesis. Use: complex decomposable work. Cost/success: higher cost, high coverage. (<prompt> | status | resume | clear)",
  graph: "Dependent multi-step work. Use: later steps need earlier results. Cost/success: highest; run when the shape demands it. (<prompt> | status | resume | clear)",
} as const;

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/** Shared subcommand completions: <prompt> | status | resume | clear. */
const goalCompletions = (prefix: string): CompletionItem[] => {
  const subs: CompletionItem[] = [
    { value: "status", label: "status", description: "show owner + mode snapshot" },
    { value: "resume", label: "resume", description: "reactivate the parked owner" },
    { value: "clear", label: "clear", description: "drop the parked owner" },
  ];
  const hits = subs.filter((item) => item.value.startsWith(prefix));
  if (prefix.length === 0) {
    return [{ value: "", label: "<prompt>", description: "run one turn in this mode" }, ...subs];
  }
  return hits;
};

const ralphCompletions = (prefix: string): CompletionItem[] => {
  const subs: CompletionItem[] = [
    { value: "start ", label: "start <name>", description: "begin a loop with a task file" },
    { value: "stop", label: "stop", description: "park the active loop" },
    { value: "status", label: "status", description: "loop + task-file progress" },
    { value: "resume", label: "resume", description: "reactivate the parked loop" },
    { value: "clear", label: "clear", description: "drop the parked loop" },
  ];
  const hits = subs.filter((item) => item.value.trim().startsWith(prefix.trim()));
  return hits.length > 0 ? hits : [{ value: "", label: "<prompt>", description: "run one turn in ralph mode" }];
};

export function registerLongHorizonCommands(
  pi: ExtensionAPI,
  gate: Gate,
  owner: OwnerCoordinator,
  ralph?: RalphLoop,
): void {
  const modeHandler = (mode: LhMode) => async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const definition = MODE_REGISTRY[mode];
    const parts = args.trim().split(/\s+/);
    const sub = parts[0];

    // Ralph-specific: start reads/writes a task file; stop suspends.
    if (mode === "ralph" && ralph && sub === "start") {
      const rest = parts.slice(1).join(" ");
      const nameMatch = rest.match(/^(?:"([^"]+)"|(\S+))\s*([\s\S]*)$/);
      if (!nameMatch) {
        notify(ctx, 'Usage: /unipi:ralph start <name> — then paste the task content, or point at an existing .unipi/ralph/<name>.md file.');
        return;
      }
      const name = (nameMatch[1] ?? nameMatch[2]).trim();
      const content = (nameMatch[3] ?? "").trim();
      if (!content) {
        notify(ctx, `Provide the task content (markdown with \`- [ ]\` items) after the name, or create .unipi/ralph/${name}.md first.`);
        return;
      }
      const started = ralph.start(name, content);
      if (!started.ok) {
        notify(ctx, `Loop not started: ${started.reason}`);
        return;
      }
      gate.setExplicit("ralph");
      notify(ctx, `Ralph loop "${started.state.name}" started — iteration 1 dispatched.`);
      return;
    }
    if (mode === "ralph" && ralph && (sub === "stop" || sub === "pause")) {
      const active = owner.getActive();
      if (active?.kind !== "ralph-loop" || !ralph.get()) {
        notify(ctx, "No active ralph loop.");
        return;
      }
      const suspended = owner.suspend("paused(user_requested)");
      notify(ctx, suspended ? `Loop parked (iteration ${ralph.get()?.iteration}). /unipi:ralph resume to continue.` : "Park slot busy — resume or clear the parked owner first.");
      return;
    }
    if (mode === "ralph" && ralph && (sub === "list" || sub === "status")) {
      const loopState = ralph.get();
      const progress = ralph.progressSummary();
      notify(
        ctx,
        loopState
          ? `Loop "${loopState.name}": iteration ${loopState.iteration}, ${progress.checked}/${progress.total} items checked.\nNext: ${progress.next.slice(0, 3).join(" · ") || "(all checked)"}\n${ownerSnapshotText(owner)}`
          : ownerSnapshotText(owner),
      );
      return;
    }

    if (sub === "status" || (sub === "" && parts.length <= 1)) {
      const current = gate.current();
      const settings = loadSettings();
      notify(
        ctx,
        `Mode command: ${definition.label}\nLast resolved: ${current ? `${current.mode} (${current.source})` : "none yet"}\n${ownerSnapshotText(owner)}` +
          `\nJudge: ${settings.judge.enabled ? `${settings.judge.provider}/${settings.judge.model} (threshold ${settings.judge.threshold})` : "off"} — default mode: ${settings.defaultMode}` +
          `\nSettings: ~/.pi/agent/settings.json → unipi.longHorizon`,
      );
      return;
    }

    if (sub === "resume") {
      if (owner.getActive()) {
        notify(ctx, `Cannot resume: ${owner.getActive()?.kind} "${owner.getActive()?.label}" is already active.`);
        return;
      }
      const resumed = owner.resume();
      if (!resumed) {
        notify(ctx, "No parked owner to resume.");
        return;
      }
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "resumed", ownerId: resumed.ownerId });
      const resumeMode = resumed.kind === "ralph-loop" ? "ralph" : resumed.kind;
      gate.setExplicit(resumeMode as LhMode);
      await pi.sendUserMessage("Continue the resumed owner from its own durable state; re-read its status before acting.");
      return;
    }

    if (sub === "clear") {
      const cleared = owner.clearParked();
      notify(
        ctx,
        cleared
          ? `Cleared parked ${cleared.kind} "${cleared.label}".`
          : "Nothing parked to clear.",
      );
      if (cleared) {
        emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "cleared", ownerId: cleared.ownerId });
      }
      return;
    }

    // <prompt> — explicit turn override. If an owner is active, suspend it
    // first (suspend-and-switch); the coordinator refuses when the park
    // slot is held and we surface that verbatim.
    if (owner.getActive()) {
      const suspended = owner.suspend(`paused(superseded_by:${mode})`);
      if (!suspended) {
        const parked = owner.getParked();
        notify(
          ctx,
          parked
            ? `${parked.kind} "${parked.label}" is parked — /unipi:${parked.kind === "ralph-loop" ? "ralph" : parked.kind} resume or clear before parking another.`
            : "Cannot switch: the active owner could not be parked.",
        );
        return;
      }
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, {
        event: "suspended",
        ownerId: suspended.ownerId,
        reason: `paused(superseded_by:${mode})`,
      });
    }
    gate.setExplicit(mode);
    await pi.sendUserMessage(args.trim());
  };

  pi.registerCommand("unipi:goal", { description: MODE_DESCRIPTIONS.goal, getArgumentCompletions: goalCompletions, handler: modeHandler("goal") });
  pi.registerCommand("unipi:ralph", { description: MODE_DESCRIPTIONS.ralph, getArgumentCompletions: ralphCompletions, handler: modeHandler("ralph") });
  pi.registerCommand("unipi:swarm", { description: MODE_DESCRIPTIONS.swarm, getArgumentCompletions: goalCompletions, handler: modeHandler("swarm") });
  pi.registerCommand("unipi:graph", { description: MODE_DESCRIPTIONS.graph, getArgumentCompletions: goalCompletions, handler: modeHandler("graph") });

}
