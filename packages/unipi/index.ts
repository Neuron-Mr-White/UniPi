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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import workflow from "@pi-unipi/workflow";
import ralph from "@pi-unipi/ralph";
import memory from "@pi-unipi/memory";
import infoScreen from "@pi-unipi/info-screen";
import subagents from "../subagents/src/index.js";
import btw from "@pi-unipi/btw/extensions/btw.js";
import webApi from "../web-api/src/index.js";
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

export default function (pi: ExtensionAPI) {
  workflow(pi);
  ralph(pi);
  memory(pi);
  infoScreen(pi);
  subagents(pi);
  btw(pi);
  webApi(pi);
  utility(pi);
  askUser(pi);
  mcp(pi);
  notify(pi);
  milestone(pi);
  kanboard(pi);
  commandEnchantment(pi);
  compactor(pi);
  footer(pi);
  updater(pi);
}
