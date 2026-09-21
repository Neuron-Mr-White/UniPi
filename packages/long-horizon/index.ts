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

  // Crash recovery: repair, don't resume — reload durable state so the gate
  // reattaches the owner's tool surface; the goal/loop engines surface their
  // own recovery fragments on their next turn.
  pi.on("session_start", () => {
    owner.restore();
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
    tools: [],
  });
}
