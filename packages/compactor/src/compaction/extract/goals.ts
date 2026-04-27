/**
 * Goal extraction — regex-based, scope changes, task verbs
 */

import type { NormalizedBlock } from "../../types.js";
import { nonEmptyLines } from "../content.js";

const SCOPE_CHANGE_RE = /\b(scope|focus|switch|move|now|instead|rather than|change|shift|pivot|let's|let us)\b/i;
const TASK_VERB_RE = /\b(add|create|build|implement|fix|refactor|update|remove|delete|rename|extract|merge|split|convert|migrate|optimize|test|write|generate|setup|configure|install|deploy|release|publish|document|review|audit|analyze|debug|resolve|handle|support|enable|disable|integrate|connect|sync|import|export|validate|verify|check|ensure|make|set|get|put|post|patch|delete)\b/i;
const GOAL_PREFIX_RE = /^(?:Goal|Objective|Task|Plan|Target|Aim|Intent|Purpose|Mission|Action item|To-do|TODO|FIXME|NOTE|IDEA|HACK|BUG|FEATURE|STORY|EPIC):?\s*/i;

export function extractGoals(blocks: NormalizedBlock[]): string[] {
  const goals: string[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user" && b.kind !== "assistant") continue;
    for (const line of nonEmptyLines(b.text)) {
      let candidate = line;
      // Strip goal prefix
      candidate = candidate.replace(GOAL_PREFIX_RE, "").trim();
      if (candidate.length < 10) continue;
      // Must contain a task verb or scope change
      if (!TASK_VERB_RE.test(candidate) && !SCOPE_CHANGE_RE.test(candidate)) continue;
      // Deduplicate
      const key = candidate.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      goals.push(candidate);
      if (goals.length >= 6) break;
    }
    if (goals.length >= 6) break;
  }

  return goals;
}
