/**
 * Commit extraction — git commit parsing, hash pairing, last 8
 */

import type { NormalizedBlock } from "../../types.js";

const COMMIT_HASH_RE = /\b[0-9a-f]{7,40}\b/gi;
const COMMIT_MSG_RE = /(?:commit|committed|git\s+(?:commit|push|merge|rebase))[^.]*?["']([^"']+)["']/i;

export interface CommitInfo {
  hash?: string;
  message: string;
}

export function extractCommits(blocks: NormalizedBlock[]): CommitInfo[] {
  const commits: CommitInfo[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user" && b.kind !== "assistant" && b.kind !== "tool_result") continue;
    const text = b.text;
    const hashes = text.match(COMMIT_HASH_RE) ?? [];
    const msgMatch = text.match(COMMIT_MSG_RE);
    const message = msgMatch?.[1]?.trim();

    for (const hash of hashes) {
      const key = hash.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      commits.push({ hash: hash.slice(0, 8), message: message || "" });
    }

    // Also catch "committed: message" without hash
    if (!hashes.length && message && message.length > 5) {
      const key = message.toLowerCase().slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        commits.push({ message });
      }
    }
  }

  return commits.slice(-8);
}

export function formatCommits(commits: CommitInfo[]): string[] {
  return commits.map((c) => {
    if (c.hash && c.message) return `${c.hash} — ${c.message}`;
    if (c.hash) return c.hash;
    return c.message;
  });
}
