/**
 * @pi-unipi/app-bridge — live bridge between this pi session and the UniPi
 * phone app (via unipi-host). See README.md.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBridge } from "./src/bridge.js";

export default function appBridge(pi: ExtensionAPI): void {
  createBridge(pi);
}

export { createBridge, bridgeDir, sweepDead, BRIDGE_VERSION, SESSION_COMMAND } from "./src/bridge.js";
export { DialogHub, wrapUi } from "./src/dialogs.js";
export * from "./src/wire.js";
