/**
 * @pi-unipi/unipi — All-in-one extension entry
 *
 * Loads every Unipi module in a single entry point.
 * Think of this as the "oh-my-zsh" for pi — one install mounts all modules.
 *
 * Usage:
 *   pi --no-extensions --no-skills -e packages/unipi/index.ts
 *   mise run unipi
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { migrateState, sweepOrphanSessions } from "@pi-unipi/core";

import workflow from "@pi-unipi/workflow";
import longHorizon from "@pi-unipi/long-horizon";
import memory from "@pi-unipi/memory";
import infoScreen from "@pi-unipi/info-screen";
import subagents from "@pi-unipi/subagents";
import backgroundTasks from "@pi-unipi/background-tasks";
import btw from "@pi-unipi/btw/extensions/btw.js";
import webApi from "@pi-unipi/web-api";
import utility from "@pi-unipi/utility";
import askUser from "@pi-unipi/ask-user";
import mcp from "@pi-unipi/mcp";
import notify from "@pi-unipi/notify";
import kanboard from "@pi-unipi/kanboard";
import commandEnchantment from "@pi-unipi/command-enchantment";
import compactor from "@pi-unipi/compactor";
import footer from "@pi-unipi/footer";
import updater from "@pi-unipi/updater";
import inputShortcuts from "@pi-unipi/input-shortcuts";
import image from "@pi-unipi/image";
import fusion from "@pi-unipi/fusion";
import watchdog from "@pi-unipi/watchdog";

export default function (pi: ExtensionAPI) {
  // One-time v3 state relocation into ~/.unipi/{global,workspace}/, then reap
  // any dead-pid session dirs left by crashed sessions. Both are best-effort
  // and version/pid-gated, so they are cheap on every subsequent startup.
  try {
    migrateState();
    sweepOrphanSessions();
  } catch {
    // Never block startup on housekeeping.
  }

  const load = (_name: string, extension: (api: ExtensionAPI) => void) => extension(pi);

  load("workflow", workflow);
  load("long-horizon", longHorizon);
  load("memory", memory);
  // Utility loads BEFORE info-screen: the name badge overlay must be pushed
  // to the BOTTOM of the overlay stack. hideOverlay() pops the topmost entry,
  // and a capturing overlay's done() callback is one-shot — if the badge were
  // stacked above the boot info-screen, the info-screen's auto-close would pop
  // the badge (spending its done()) and strand the dashboard uncloseable.
  load("utility", utility);
  load("info-screen", infoScreen);
  load("subagents", subagents);
  load("background-tasks", backgroundTasks);
  load("btw", btw);
  load("web-api", webApi);
  load("ask-user", askUser);
  load("mcp", mcp);
  load("notify", notify);
  load("kanboard", kanboard);
  load("command-enchantment", commandEnchantment);
  load("compactor", compactor);
  load("footer", footer);
  load("updater", updater);
  load("input-shortcuts", inputShortcuts);
  load("image", image);
  load("fusion", fusion);
  load("watchdog", watchdog);
}
