/**
 * @pi-unipi/core — All-in-one extension entry
 *
 * Loads every Unipi extension in a single entry point.
 * Used by `mise run core` and the root package.json pi.extensions.
 *
 * Think of this as the "oh-my-zsh" for pi — one install mounts all modules.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import workflow from "@pi-unipi/workflow";
import ralph from "@pi-unipi/ralph";
import memory from "@pi-unipi/memory";
import infoScreen from "@pi-unipi/info-screen";
import subagents from "../subagents/src/index.js";
import btw from "@pi-unipi/btw/extensions/btw.js";

export default function (pi: ExtensionAPI) {
  workflow(pi);
  ralph(pi);
  memory(pi);
  infoScreen(pi);
  subagents(pi);
  btw(pi);
}
