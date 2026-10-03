/**
 * @pi-unipi/ask-user — settings (namespace `ask-user`, /unipi:settings → Ask User)
 *
 *   enabled        — give the agent the ask_user tool (OFF by default)
 *   notifyOnAsk    — notification when the agent stops to ask
 *   escape         — stop: Esc stops the agent's turn (Devin)
 *                    send: Esc sends what's answered, the rest as skipped
 *   digitAdvance   — a number key in a single-choice question also moves on
 *   helpLine       — show "? Not ready to answer, help me out!"
 *   other          — agent: the agent decides (on unless it sets other:false)
 *                    always / never: override the agent
 *   maxQuestions   — questions per call the agent may ask (1–4)
 *
 * Read fresh on every call, so changes in the hub apply to the next question.
 */

import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";

export interface AskUserSettings {
  enabled: boolean;
  notifyOnAsk: boolean;
  escape: "stop" | "send";
  digitAdvance: boolean;
  helpLine: boolean;
  other: "agent" | "always" | "never";
  maxQuestions: number;
}

export const DEFAULT_SETTINGS: AskUserSettings = {
  enabled: false,
  notifyOnAsk: true,
  escape: "stop",
  digitAdvance: true,
  helpLine: true,
  other: "agent",
  maxQuestions: 4,
};

registerSettings({
  namespace: "ask-user",
  label: "Ask User",
  defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Tool",
      fields: [
        { key: "enabled", type: "boolean", label: "Enable ask_user", description: "Let the agent stop and ask you multiple-choice questions." },
        { key: "notifyOnAsk", type: "boolean", label: "Notify when asked", description: "Send a notification when the agent is waiting for your answer." },
        { key: "maxQuestions", type: "number", label: "Questions per call", min: 1, max: 4, description: "How many questions one dialog may hold. Applies to new sessions." },
      ],
    },
    {
      title: "Dialog",
      description: "How the question dialog behaves",
      fields: [
        {
          key: "escape",
          type: "enum",
          label: "Esc",
          options: [
            { value: "stop", label: "stop", description: "stop the agent's turn" },
            { value: "send", label: "send", description: "send what's answered, skip the rest" },
          ],
          description: "What Esc does in the dialog.",
        },
        { key: "digitAdvance", type: "boolean", label: "Number keys move on", description: "In a single-choice question, picking with 1–9 also advances." },
        {
          key: "other",
          type: "enum",
          label: "\"Other\" choice",
          options: [
            { value: "agent", label: "agent decides", description: "on unless the agent opts out" },
            { value: "always", label: "always", description: "always offer the Other row" },
            { value: "never", label: "never", description: "never offer the Other row" },
          ],
          description: "The free-text \"Other (type your own)\" row.",
        },
        { key: "helpLine", type: "boolean", label: "\"Not ready\" line", description: "Show \"? Not ready to answer, help me out!\" under the dialog." },
      ],
    },
  ],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAskUserSettings(cwd: string = process.cwd()): AskUserSettings {
  let raw: Record<string, unknown> = {};
  try {
    const s = getSettings("ask-user", cwd);
    if (isRecord(s)) raw = s;
  } catch {
    // defaults
  }
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const max = typeof raw.maxQuestions === "number" ? Math.min(4, Math.max(1, Math.floor(raw.maxQuestions))) : DEFAULT_SETTINGS.maxQuestions;
  return {
    enabled: bool(raw.enabled, DEFAULT_SETTINGS.enabled),
    notifyOnAsk: bool(raw.notifyOnAsk, DEFAULT_SETTINGS.notifyOnAsk),
    escape: raw.escape === "send" ? "send" : "stop",
    digitAdvance: bool(raw.digitAdvance, DEFAULT_SETTINGS.digitAdvance),
    helpLine: bool(raw.helpLine, DEFAULT_SETTINGS.helpLine),
    other: raw.other === "always" || raw.other === "never" ? raw.other : "agent",
    maxQuestions: max,
  };
}

export function saveAskUserSettings(settings: Partial<AskUserSettings>, cwd: string = process.cwd()): void {
  setSettings("ask-user", settings as Record<string, unknown>, "global", cwd);
}
