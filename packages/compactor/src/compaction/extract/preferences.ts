/**
 * User preference extraction — track explicit preferences and constraints
 */

import type { NormalizedBlock } from "../../types.js";
import { nonEmptyLines } from "../content.js";

const PREF_RE = /\b(prefer|preference|want|would like|should|must|need to|important|critical|avoid|don't|do not|never|always|only|make sure|ensure|remember|keep in mind|note that)\b/i;
const PREF_PREFIX_RE = /^(?:Preference|Note|Remember|Keep in mind|Important|Critical|Constraint|Rule|Guideline|Style|Format):?\s*/i;

export function extractPreferences(blocks: NormalizedBlock[]): string[] {
  const prefs: string[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    for (const line of nonEmptyLines(b.text)) {
      let candidate = line.replace(PREF_PREFIX_RE, "").trim();
      if (candidate.length < 10) continue;
      if (!PREF_RE.test(candidate)) continue;
      const key = candidate.toLowerCase().slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      prefs.push(candidate);
      if (prefs.length >= 10) break;
    }
    if (prefs.length >= 10) break;
  }

  return prefs;
}

/** Remove preferences that overlap with goals */
export function dedupPreferencesAgainstGoals(prefs: string[], goals: string[]): string[] {
  const goalSet = new Set(goals.map((g) => g.toLowerCase().slice(0, 60)));
  return prefs.filter((p) => {
    const key = p.toLowerCase().slice(0, 60);
    return !goalSet.has(key);
  });
}
