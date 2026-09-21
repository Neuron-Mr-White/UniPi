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

export function registerLongHorizonCommands(
  pi: ExtensionAPI,
  gate: Gate,
  owner: OwnerCoordinator,
): void {
  const registerModeCommand = (mode: LhMode): void => {
    const definition = MODE_REGISTRY[mode];
    pi.registerCommand(`unipi:${mode}`, {
      description: `${definition.label} mode — ${definition.rubric} (<prompt> | status | resume | clear)`,
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/);
        const sub = parts[0];

        if (sub === "status" || (sub === "" && parts.length <= 1)) {
          const current = gate.current();
          notify(
            ctx,
            `Mode command: ${definition.label}\nLast resolved: ${current ? `${current.mode} (${current.source})` : "none yet"}\n${ownerSnapshotText(owner)}`,
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
      },
    });
  };

  for (const mode of ["goal", "ralph", "swarm", "graph"] as const) {
    registerModeCommand(mode);
  }

  pi.registerCommand("unipi:continue", {
    description: "Resume the parked long-horizon owner (if any)",
    handler: async (_args, ctx) => {
      if (owner.getActive()) {
        notify(ctx, `The active ${owner.getActive()?.kind} owner continues on its own; nothing to resume.`);
        return;
      }
      const resumed = owner.resume();
      if (!resumed) {
        notify(ctx, "No parked owner — nothing to continue.");
        return;
      }
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, { event: "resumed", ownerId: resumed.ownerId });
      const resumeMode = (resumed.kind === "ralph-loop" ? "ralph" : resumed.kind) as LhMode;
      gate.setExplicit(resumeMode);
      await pi.sendUserMessage("Continue the resumed owner from its own durable state; re-read its status before acting.");
    },
  });
}
