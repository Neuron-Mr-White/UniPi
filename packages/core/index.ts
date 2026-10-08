/**
 * @unipi/core — Shared utilities for Unipi extension suite
 *
 * Re-exports all constants, events, and utilities.
 */

export * from "./constants.js";
export * from "./events.js";
export * from "./bus.js";
export * from "./utils.js";
export * from "./model-cache.js";
export * from "./tui-width.js";
export * from "./tui-overlay.js";
export * from "./bounded-output.js";
export * from "./spinner-line.js";
export * from "./kanboard-label.js";
export * from "./command-echo.js";
export * from "./src/turn/arbiter.js";
export * from "./src/work/index.js";
export * from "./src/evidence.js";

// v3 workspace identity + state layout (marker-file id, per-workspace roots)
export * from "./src/workspace/identity.js";
export * from "./src/workspace/paths.js";
export * from "./src/package-colors.js";
export * from "./src/tui/hub-kit.js";
export * from "./src/tui/kit.js";
export * from "./src/tui/progress.js";
export * from "./src/tui/viz.js";
export * from "./src/compaction-savings.js";
export * from "./src/jev/client.js";
export * from "./src/jev/settings.js";
export * from "./src/jev/chatter.js";
export * from "./src/workspace/state-migration.js";
// v3 settings engine + migration (canonical ~/.unipi/config layout)
export * from "./src/settings/paths.js";
export * from "./src/settings/engine.js";
export * from "./src/settings/schema.js";
export { SettingsHub, type SettingsHubDeps } from "./src/settings/hub.js";
export { openSettingsHub } from "./src/settings/open.js";
export * from "./src/attach/detect.js";
export * from "./src/settings/catalog.js";
export * from "./command-runner.js";
export * from "./detachable-bash.js";
export * from "./compaction-context.js";
export * from "./move.js";
export * from "./src/settings/migrations.js";
export * from "./src/hints/index.js";
export * from "./src/hints/store.js";
export { CRAB_14_LINES_256, CRAB_14_LINES_TRUECOLOR, CRAB_22_LINES_256, CRAB_22_LINES_TRUECOLOR } from "./src/hints/crab-data.js";
export * from "./harness-messages.js";
export * from "./remote-dialogs.js";
