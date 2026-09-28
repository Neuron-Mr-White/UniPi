/**
 * Chatter detection shared by jev consumers (auto-rename, skill judging):
 * greetings, thanks, acknowledgements and bare "continue"-style nudges carry
 * no subject, so no decision should be made from them.
 */

const CHATTER = new RegExp(
  "^(?:" + [
    "h(?:i|ello|ey|owdy)(?: there)?", "yo", "sup", "good (?:morning|afternoon|evening)",
    "thanks?(?: you)?(?: so much)?", "thx", "ty", "cheers", "nice", "great", "cool", "perfect", "awesome",
    "ok(?:ay)?", "k", "yes", "yep", "yeah", "no", "nope", "sure", "lgtm", "sounds good", "go(?: on| ahead)?",
    "continue", "proceed", "retry", "again", "do it", "next", "done",
  ].join("|") + ")[\\s.!?,]*$",
  "i",
);

/** True for messages with no subject of their own (no jev call needed). */
export function isChatter(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return true;
  if (t.startsWith("/")) return true;
  return CHATTER.test(t);
}

