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
  /** When true, selecting this option allows the user to add custom text before submitting */
  allowCustom?: boolean;
  /**
   * Special action for this option:
   * - "select": normal selection (default)
   * - "input": enter text input mode, return combined response
   * - "end_turn": signal end of agent turn
   * - "new_session": start a new session with optional prefill message
   */
  action?: "select" | "input" | "end_turn" | "new_session";
  /** Prefill message for new_session action */
  prefill?: string;
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
  kind: "selection" | "freeform" | "combined" | "cancelled" | "timed_out" | "end_turn" | "new_session";
  /** Selected option values (for selection kind) */
  selections?: string[];
  /** Freeform text (for freeform kind) */
  text?: string;
  /** Prefill message (for new_session kind) */
  prefill?: string;
  /** Optional user comment */
  comment?: string;
}

/** Result from the session launcher UI */
export interface SessionLauncherResult {
  action: "compact" | "direct" | "cancel";
  prefill: string;
}

/** Normalized option with resolved value */
export interface NormalizedOption {
  label: string;
  description?: string;
  value: string;
  /** When true, selecting this option allows the user to add custom text before submitting */
  allowCustom?: boolean;
  /** Special action for this option */
  action?: "select" | "input" | "end_turn" | "new_session";
  /** Prefill message for new_session action */
  prefill?: string;
}
