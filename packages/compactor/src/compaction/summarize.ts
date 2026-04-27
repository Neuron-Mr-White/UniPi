/**
 * Main compile() orchestrator — all 6 stages
 */

import type { Message } from "@mariozechner/pi-ai";
import type { CompileInput, FileOps } from "../types.js";
import { normalizeMessages } from "./normalize.js";
import { filterNoise } from "./filter-noise.js";
import { buildSections } from "./build-sections.js";
import { formatSummary, RECALL_NOTE } from "./format.js";
import { mergePrevious } from "./merge.js";

export const compile = (input: CompileInput): string => {
  const blocks = filterNoise(normalizeMessages(input.messages));
  const data = buildSections({ blocks });
  const fresh = formatSummary(data);
  const prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  const merged = prev ? mergePrevious(prev, fresh) : fresh;
  if (!merged) return "";
  return merged + "\n\n---\n\n" + RECALL_NOTE;
};

const stripRecallNote = (text: string): string => {
  const idx = text.lastIndexOf(RECALL_NOTE);
  if (idx < 0) return text;
  return text.slice(0, idx).replace(/\s*(?:\n\n---\n\n)?\s*$/, "").trimEnd();
};
