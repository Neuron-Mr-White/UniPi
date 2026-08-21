/**
 * Main compile() orchestrator — all 6 stages
 */

import type { Message } from "@earendil-works/pi-ai";
import type { CompileInput, FileOps, NormalizedBlock } from "../types.js";
import { normalizeMessages } from "./normalize.js";
import { filterNoise } from "./filter-noise.js";
import { buildSections } from "./build-sections.js";
import { formatSummary, RECALL_NOTE } from "./format.js";
import { mergePrevious, mergeBriefTranscriptWithFreshBudget } from "./merge.js";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank.js";

export interface RankedCompileInput extends CompileInput {
  fileOps?: FileOps;
  ranking?: BriefRankingOptions;
}

interface CompileWithBriefBlocksOptions {
  briefBlocksFor?: (blocks: NormalizedBlock[]) => NormalizedBlock[];
  capFreshBrief?: boolean;
  preserveFreshBriefOnMerge?: boolean;
}

const compileWithBriefBlocks = (input: CompileInput, options: CompileWithBriefBlocksOptions = {}): string => {
  const blocks = filterNoise(normalizeMessages(input.messages));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  const data = buildSections({ blocks, briefBlocks });
  const fresh = formatSummary(data, { capBriefTranscript: options.capFreshBrief ?? true });
  const prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  const merged = prev
    ? mergePrevious(prev, fresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge })
    : fresh;
  if (!merged) return "";
  return merged + "\n\n---\n\n" + RECALL_NOTE;
};

export const compile = (input: CompileInput): string =>
  compileWithBriefBlocks(input);

export const compileRanked = (input: RankedCompileInput): string =>
  compileWithBriefBlocks(input, {
    briefBlocksFor: (blocks) =>
      selectRankedBriefBlocks(blocks, {
        ...input.ranking,
        fileOps: input.ranking?.fileOps ?? input.fileOps,
      }),
    capFreshBrief: false,
    preserveFreshBriefOnMerge: true,
  });

const stripRecallNote = (text: string): string => {
  const idx = text.lastIndexOf(RECALL_NOTE);
  if (idx < 0) return text;
  return text.slice(0, idx).replace(/\s*(?:\n\n---\n\n)?\s*$/, "").trimEnd();
};

export { mergeBriefTranscriptWithFreshBudget };
