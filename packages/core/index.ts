/**
 * @unipi/core — Shared utilities for Unipi extension suite
 *
 * Re-exports all constants, events, and utilities.
 */

export * from "./constants.js";
export * from "./events.js";
export * from "./utils.js";
export * from "./model-cache.js";
export * from "./tui-width.js";
export * from "./tui-overlay.js";
export * from "./bounded-output.js";
export * from "./spinner-line.js";
export * from "./fusion-status.js";
export * from "./long-horizon-status.js";
export * from "./long-horizon-owner-status.js";
export * from "./kanboard-status.js";
export * from "./plan-permission-status.js";
export * from "./command-echo.js";
export * from "./src/turn/arbiter.js";
export * from "./src/evidence.js";

// v3 workspace identity + state layout (marker-file id, per-workspace roots)
export * from "./src/workspace/identity.js";
export * from "./src/workspace/paths.js";
export * from "./src/package-colors.js";
export * from "./src/tui/hub-kit.js";
export * from "./src/tui/kit.js";
export * from "./src/tui/progress.js";
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
export * from "./compaction-context.js";
export * from "./src/settings/migrations.js";
export * from "./src/hints/index.js";
export * from "./src/hints/store.js";
export * from "./harness-messages.js";
