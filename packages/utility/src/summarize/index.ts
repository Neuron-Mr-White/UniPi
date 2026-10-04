/**
 * @pi-unipi/utility — /unipi:summarize [focus]
 *
 * Runs the bundled `summarize` skill again on the last reply. The command
 * sends `/skill:summarize` (plus the user's own text, if any), so pi inlines
 * the skill file into the turn, the agent cannot skip it, and the command
 * adds no wording of its own.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sendHarnessUserMessage, UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";

export const SUMMARIZE_SKILL = "summarize";

/** The text the command sends: the skill, plus the user's own text (if any) as-is. */
export function summarizePrompt(focus: string): string {
  const f = focus.trim();
  return f ? `/skill:${SUMMARIZE_SKILL} ${f}` : `/skill:${SUMMARIZE_SKILL}`;
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
      const focus = (args ?? "").trim();
      sendHarnessUserMessage(
        pi,
        summarizePrompt(focus),
        { source: "Utility", title: "Summarize", synopsis: focus ? `ask: ${focus}` : "last reply" },
        { expandPromptTemplates: true },
      );
      // sendUserMessage does not wait. Print mode (-p) exits when the handler
      // returns, so wait for the summary turn to start and end.
      await new Promise((r) => setTimeout(r, 0));
      await ctx.waitForIdle?.();
    },
  });
}
