/**
 * Badge (session-name) generation — in-process one-shot. No child pi:
 * a throwaway in-memory agent session with no tools, one prompt, using the
 * configured badge model (.unipi/config/badge.json generationModel) or the
 * parent's model. Sets pi.setSessionName with the result — the utility badge
 * state picks it up by polling getSessionName().
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UnipiBadgeGenerateRequestEvent } from "@pi-unipi/core";
import { createInMemoryBadgeSession } from "./badge-session.js";

export async function badgeHandler(
  pi: ExtensionAPI,
  event: UnipiBadgeGenerateRequestEvent,
  ctx?: { model?: unknown; modelRegistry?: unknown; cwd?: string; thinkingLevel?: string },
): Promise<void> {
  const summary = event?.conversationSummary ?? "";
  const prompt = summary
    ? `Based on this conversation, generate a concise session title (MAX 5 WORDS). Reply with ONLY the title. No quotes, no explanation, no punctuation.\n\nConversation:\n${summary}`
    : `Generate a concise session title (MAX 5 WORDS) for this session. Reply with ONLY the title. No quotes, no explanation, no punctuation.`;

  // .unipi/config/badge.json { generationModel } — "inherit" or absent → parent model.
  let modelInput: string | undefined;
  try {
    const configPath = join(process.cwd(), ".unipi", "config", "badge.json");
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { generationModel?: unknown };
      if (typeof parsed.generationModel === "string" && parsed.generationModel !== "inherit") modelInput = parsed.generationModel;
    }
  } catch {
    /* inherit */
  }

  try {
    const name = await createInMemoryBadgeSession(ctx ?? {}, prompt, modelInput);
    if (typeof name === "string" && name.length > 0) pi.setSessionName(name.slice(0, 60));
  } catch {
    /* badge naming is best-effort */
  }
}
