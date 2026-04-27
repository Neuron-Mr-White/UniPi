/**
 * Section data type for compaction pipeline
 */

import type { TranscriptEntry } from "../types.js";

export interface SectionData {
  sessionGoal: string[];
  filesAndChanges: string[];
  commits: string[];
  outstandingContext: string[];
  userPreferences: string[];
  briefTranscript: string;
  transcriptEntries: TranscriptEntry[];
}
