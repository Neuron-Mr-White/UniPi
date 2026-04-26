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

export default function (pi: ExtensionAPI) {
  workflow(pi);
  ralph(pi);
  memory(pi);
  infoScreen(pi);
  subagents(pi);
  btw(pi);
  webApi(pi);
}
