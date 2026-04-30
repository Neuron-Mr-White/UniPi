/**
 * Auto-injection builder — builds minimal behavioral state injection
 * after compaction. Budget: 150 tokens max.
 *
 * Only includes:
 * - behavioral_directive (role event) — never dropped
 * - session_mode (intent event) — only if budget remains
 *
 * Rules and active_skills are dropped from auto-injection (findable via session_recall).
 */

import type { StoredEvent } from "../types.js";

const MAX_TOKENS = 150;

function estimateTokens(text: string): number {
  // Rough: ~4 chars per token
  return Math.ceil(text.length / 4);
}

export interface AutoInjection {
  text: string;
  tokens: number;
}

export function buildAutoInjection(events: StoredEvent[]): AutoInjection | null {
  const parts: string[] = [];
  let tokenBudget = MAX_TOKENS;

  // 1. behavioral_directive (role) — critical, always included
  const roleEvents = events.filter((e) => e.category === "rule");
  if (roleEvents.length > 0) {
    const directive = roleEvents[roleEvents.length - 1].data;
    const directiveText = `[Role Directive]\n${directive}`;
    const tokens = estimateTokens(directiveText);
    if (tokens <= tokenBudget) {
      parts.push(directiveText);
      tokenBudget -= tokens;
    }
  }

  // 2. session_mode (intent) — included if budget remains
  if (tokenBudget > 80) {
    const intentEvents = events.filter((e) => e.category === "intent");
    if (intentEvents.length > 0) {
      const mode = intentEvents[intentEvents.length - 1].data;
      const modeText = `[Session Mode]\n${mode}`;
      const tokens = estimateTokens(modeText);
      if (tokens <= tokenBudget) {
        parts.push(modeText);
        tokenBudget -= tokens;
      }
    }
  }

  if (parts.length === 0) return null;

  const text = parts.join("\n\n");
  return { text, tokens: estimateTokens(text) };
}
