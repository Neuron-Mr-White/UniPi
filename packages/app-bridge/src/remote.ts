/** Publishes the bridge's DialogHub as core's remote dialog racer. */
import { setRemoteDialogRacer } from "@pi-unipi/core";
import type { DialogHub } from "./dialogs.js";

export function setRemoteDialogs(hub: DialogHub | undefined): void {
  setRemoteDialogRacer(hub ? { race: (spec, runTui, fromPhone, outer) => hub.race(spec, runTui, fromPhone, outer) } : undefined);
}
