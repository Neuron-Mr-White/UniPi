/**
 * @pi-unipi/background-tasks — Module entry
 *
 * Master-toggle gate: when config `enabled` is false, this registers NOTHING
 * (no tools, no commands, no hooks, no UI). Phase 0 skeleton; the full
 * extension wiring lands in Phases 1-6.
 */

import { loadBackgroundTasksConfig } from "./config.js";

export default function backgroundTasksExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI): void {
  const { config, warnings } = loadBackgroundTasksConfig(process.cwd());

  for (const warning of warnings) {
    console.error(`[background-tasks] ${warning}`);
  }

  if (!config.enabled) {
    return;
  }

  // ── Phase 1+: registry, tools, commands, UI, delegate, fusion, attribution ──
  void pi;
}
