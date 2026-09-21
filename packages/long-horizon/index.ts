/**
 * @pi-unipi/long-horizon — Extension entry
 *
 * Mode-gated long-horizon execution: /goal /ralph /swarm /graph behind a
 * prompt judge (TypeSafe jev). One automation owner per session, max one
 * parked. Design: docs/long-horizon-design.md.
 */

import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitEvent, getPackageVersion, UNIPI_EVENTS } from "@pi-unipi/core";
import { OwnerCoordinator, type OwnerEvent } from "./src/owner.js";
import { Gate } from "./src/gate.js";
import { registerLongHorizonCommands } from "./src/commands.js";
import { loadSettings } from "./src/settings.js";
import { GoalMachine } from "./src/engine/goal-state.js";
import { GoalToolset } from "./src/tools/goal.js";
import { GoalContinuation } from "./src/engine/continuation.js";
import { wireRuntime } from "./src/runtime.js";

export * from "./src/modes.js";
export * from "./src/owner.js";
export * from "./src/gate.js";

const LH_DIR = ".unipi/long-horizon";

export default function longHorizon(pi: ExtensionAPI): void {
  const version = getPackageVersion("long-horizon");
  const statePath = () => join(resolve(process.cwd()), LH_DIR, "state.json");

  // Owner lifecycle → unipi event bus (footer/info-screen consume these).
  const owner = new OwnerCoordinator({
    statePath,
    onChange: (_snapshot, event: OwnerEvent) => {
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, {
        event: event.type,
        ...("owner" in event && event.owner
          ? { ownerId: event.owner.ownerId, kind: event.owner.kind, status: event.owner.status }
          : {}),
      });
    },
  });

  const gate = new Gate({ owner, loadSettings });
  gate.register(pi);
  registerLongHorizonCommands(pi, gate, owner);

  // Goal engine: machine + tools + continuation + runtime wiring.
  const machine = new GoalMachine({
    statePath: () => join(resolve(process.cwd()), LH_DIR, "goal.json"),
  });
  const toolset = new GoalToolset({ machine, owner });
  toolset.register(pi);
  const continuation = new GoalContinuation({
    machine,
    toolset,
    owner,
    verifier: { evaluate: async () => { throw new Error("verifier unbound"); } },
    send: (message) => {
      void pi.sendUserMessage(message);
    },
  });
  wireRuntime(pi, { machine, toolset, continuation, gate, loadSettings });

  // Crash recovery: repair, don't resume — reload durable state so the gate
  // reattaches the owner's tool surface; the continuation arms a recovery
  // fragment for the first post-restart turn.
  pi.on("session_start", () => {
    owner.restore();
    machine.restore();
    if (machine.getActive()) continuation.armRecovery();
  });

  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
    name: "@pi-unipi/long-horizon",
    version,
    commands: [
      "unipi:goal",
      "unipi:ralph",
      "unipi:swarm",
      "unipi:graph",
      "unipi:continue",
    ],
    tools: ["create_goal", "get_goal", "update_goal"],
  });
}
