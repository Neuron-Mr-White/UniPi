/**
 * @pi-unipi/utility — image: tools + recognize gating
 *
 * image_recognize is hidden while the session model can see images itself
 * (pi's read tool already hands it the pixels) and comes back for text-only
 * models.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMAGE_TOOLS } from "@pi-unipi/core";
import { applyRecognizeGating } from "./models.js";
import { loadConfig } from "./settings.js";
import { registerImageTools } from "./tools.js";

export { imageCatalogEntries, refreshImageModelCache } from "./models.js";
export { loadConfig as loadImageConfig } from "./settings.js";

export function registerImage(pi: ExtensionAPI): void {
  registerImageTools(pi);

  const gate = (model: unknown) => {
    try {
      if (!loadConfig().recognize.enabled) return;
      const active = pi.getActiveTools();
      const next = applyRecognizeGating(active, model, IMAGE_TOOLS.RECOGNIZE);
      if (next !== active) pi.setActiveTools(next);
    } catch {
      // tools not ready — next event retries
    }
  };
  pi.on("session_start", (_e, ctx) => gate(ctx.model));
  pi.on("model_select", (event) => gate(event.model));
}
