/**
 * @pi-unipi/utility — /unipi:summarize [focus]
 *
 * Asks the agent for a summary of the session in the shape the bundled
 * `summarize` skill sets. The command sends `/skill:summarize`, so pi
 * inlines the skill file into the turn, and the agent cannot skip it.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";

export const SUMMARIZE_SKILL = "summarize";

/** The prompt the command sends. `focus` narrows the summary; empty means the whole session. */
export function summarizePrompt(focus: string): string {
  const f = focus.trim();
  const scope = f
    ? `Summarize this session for me, with the focus on: ${f}`
    : "Summarize this session for me: what we did, why, and where it stands now.";
  return `/skill:${SUMMARIZE_SKILL} ${scope} Use only what happened in this session. Do not call tools.`;
}

/** True when pi can expand `/skill:summarize` (the skill is loaded and on). */
export function hasSummarizeSkill(pi: ExtensionAPI): boolean {
  try {
    return pi.getCommands().some((c) => c.name === `skill:${SUMMARIZE_SKILL}`);
  } catch {
    return false;
  }
}

export function registerSummarizeCommand(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.SUMMARIZE}`, {
    description: "Summarize this session for you (answer first, then findings, open items, questions); add text to set a focus",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) ctx.ui.notify("Agent is busy. Press ESC to interrupt, then try again.", "warning");
        return;
      }
      if (!hasSummarizeSkill(pi)) {
        if (ctx.hasUI) ctx.ui.notify("The summarize skill is off or missing. Turn it on in /unipi:skills.", "warning");
        return;
      }
      pi.sendUserMessage(summarizePrompt(args ?? ""), { expandPromptTemplates: true });
      // sendUserMessage does not wait. Print mode (-p) exits when the handler
      // returns, so wait for the summary turn to start and end.
      await new Promise((r) => setTimeout(r, 0));
      await ctx.waitForIdle?.();
    },
  });
}
