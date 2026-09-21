/**
 * @pi-unipi/long-horizon — Extension entry
 *
 * Mode-gated long-horizon execution: /goal /ralph /swarm /graph behind a
 * prompt judge (TypeSafe jev). One automation owner per session, max one
 * parked. Design: docs/long-horizon-design.md.
 *
 * Phase 1 (current): mode registry + owner coordinator. The gate, judge,
 * tools, and commands arrive in later phases — this entry only wires what
 * exists so the package loads cleanly in the umbrella.
 */

import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitEvent, getPackageVersion, UNIPI_EVENTS } from "@pi-unipi/core";

export * from "./src/modes.js";
export * from "./src/owner.js";

const LH_DIR = ".unipi/long-horizon";

export default function longHorizon(pi: ExtensionAPI): void {
  const version = getPackageVersion("long-horizon");
  const statePath = () => join(resolve(process.cwd()), LH_DIR, "state.json");

  // Owner coordinator is created lazily by later phases; the state path is
  // exported for tests and the upcoming gate.
  emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
    name: "@pi-unipi/long-horizon",
    version,
    commands: [],
    tools: [],
  });
}
