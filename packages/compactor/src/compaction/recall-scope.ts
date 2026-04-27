/**
 * Recall scope — lineage filtering for vcc_recall
 */

export interface LineageRange {
  startIndex: number;
  endIndex: number;
}

/**
 * Determine the valid message index range for recall based on
 * the most recent compaction boundary.
 */
export function getRecallScope(
  branchEntries: any[],
  opts?: { expand?: boolean },
): LineageRange {
  let lastCompactionIdx = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      break;
    }
  }

  // If expand is true, include everything; otherwise only post-compaction
  const startIndex = opts?.expand ? 0 : lastCompactionIdx + 1;
  return {
    startIndex: Math.max(0, startIndex),
    endIndex: branchEntries.length,
  };
}
