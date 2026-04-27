/**
 * @pi-unipi/ask-user — TypeScript types
 */

/** Option for ask_user tool */
export interface AskUserOption {
  /** Display label */
  label: string;
  /** Optional description shown below label */
  description?: string;
  /** Value returned when selected (defaults to label) */
  value?: string;
}

/** Parameters for ask_user tool */
export interface AskUserParams {
  /** The question to ask the user */
  question: string;
  /** Additional context shown before the question */
  context?: string;
  /** Multiple-choice options (omit for freeform-only) */
  options?: AskUserOption[];
  /** Enable multi-select mode (default: false) */
  allowMultiple?: boolean;
  /** Allow freeform text input (default: true) */
  allowFreeform?: boolean;
  /** Auto-dismiss after N milliseconds */
  timeout?: number;
}

/** Response from ask_user tool */
export interface AskUserResponse {
  /** Response kind */
  kind: "selection" | "freeform" | "combined" | "cancelled" | "timed_out";
  /** Selected option values (for selection kind) */
  selections?: string[];
  /** Freeform text (for freeform kind) */
  text?: string;
  /** Optional user comment */
  comment?: string;
}

/** Normalized option with resolved value */
export interface NormalizedOption {
  label: string;
  description?: string;
  value: string;
}
