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

import workflow from "@pi-unipi/workflow";
import ralph from "@pi-unipi/ralph";
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
import milestone from "@pi-unipi/milestone";
import kanboard from "@pi-unipi/kanboard";
import commandEnchantment from "@pi-unipi/command-enchantment";
import compactor from "@pi-unipi/compactor";
import footer from "@pi-unipi/footer";
import updater from "@pi-unipi/updater";
import inputShortcuts from "@pi-unipi/input-shortcuts";
import image from "@pi-unipi/image";

export default function (pi: ExtensionAPI) {
  workflow(pi);
  ralph(pi);
  memory(pi);
  // Utility loads BEFORE info-screen: the name badge overlay must be pushed
  // to the BOTTOM of the overlay stack. hideOverlay() pops the topmost entry,
  // and a capturing overlay's done() callback is one-shot — if the badge were
  // stacked above the boot info-screen, the info-screen's auto-close would pop
  // the badge (spending its done()) and strand the dashboard uncloseable.
  utility(pi);
  infoScreen(pi);
  subagents(pi);
  backgroundTasks(pi);
  btw(pi);
  webApi(pi);
  askUser(pi);
  mcp(pi);
  notify(pi);
  milestone(pi);
  kanboard(pi);
  commandEnchantment(pi);
  compactor(pi);
  footer(pi);
  updater(pi);
  inputShortcuts(pi);
  image(pi);
}
