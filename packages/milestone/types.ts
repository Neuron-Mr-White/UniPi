/**
 * @pi-unipi/milestone — Type definitions
 */

/** A single item within a milestone phase */
export interface MilestoneItem {
  /** Item text (without checkbox) */
  text: string;
  /** Whether item is checked off */
  checked: boolean;
  /** Line number in the source file (1-indexed) */
  lineNumber: number;
}

/** A phase grouping milestone items */
export interface MilestonePhase {
  /** Phase name (e.g., "Phase 1: Foundation") */
  name: string;
  /** Optional description (from `>` blockquote lines) */
  description?: string;
  /** Items in this phase */
  items: MilestoneItem[];
}

/** Parsed representation of a MILESTONES.md file */
export interface MilestoneDoc {
  /** Document title from frontmatter */
  title: string;
  /** Creation date (ISO string) */
  created: string;
  /** Last update date (ISO string) */
  updated: string;
  /** Ordered list of phases */
  phases: MilestonePhase[];
  /** Source file path */
  filePath: string;
}

/** Per-phase progress */
export interface PhaseProgress {
  /** Phase name */
  name: string;
  /** Completed items in this phase */
  done: number;
  /** Total items in this phase */
  total: number;
}

/** Progress summary across all phases */
export interface ProgressSummary {
  /** Total items across all phases */
  totalItems: number;
  /** Completed items across all phases */
  completedItems: number;
  /** Overall completion percentage (0-100) */
  percentComplete: number;
  /** Name of the current phase (first with incomplete items) */
  currentPhase: string;
  /** Per-phase progress */
  phases: PhaseProgress[];
}
