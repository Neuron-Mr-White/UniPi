/**
 * @pi-unipi/dream — settings (namespace `dream`)
 *
 *   enabled       — OFF by default. When on, the dream check runs on pi open.
 *                   Turn it on in /unipi:settings → Dream. `/unipi:dream run`
 *                   (and the tray / app "Run now") work even while it's off.
 *   minSessions   — how many new struggle sessions since the last dream
 *                   before another one is due (default 5).
 *   minGapHours   — minimum hours between dreams (default 12).
 *   model         — optional "provider/model" for the dream child;
 *                   empty = the session default.
 *   thinking      — child thinking level (default medium).
 *   skillsTarget  — where approved crafted skills land (default .agents/skills,
 *                   project-relative).
 *   maxRuntimeMin — hard cap for one dream run (default 40).
 */

import { registerSettings, type SettingsSection } from "@pi-unipi/core";

export interface DreamSettings {
  enabled: boolean;
  minSessions: number;
  minGapHours: number;
  model: string;
  thinking: string;
  skillsTarget: string;
  maxRuntimeMin: number;
}

export const DEFAULT_DREAM: DreamSettings = {
  enabled: false,
  minSessions: 5,
  minGapHours: 12,
  model: "",
  thinking: "medium",
  skillsTarget: ".agents/skills",
  maxRuntimeMin: 40,
};

export const NAMESPACE = "dream";

const SECTIONS: SettingsSection[] = [
  {
    title: "Dream",
    description: "Background retrospection over past sessions: lessons into memory, skills proposed for approval",
    fields: [
      { key: "enabled", type: "boolean", label: "Dream in the background", description: "Off by default. On: every time pi opens, start a background dream when enough new sessions piled up. /unipi:dream run works either way." },
      { key: "minSessions", type: "number", label: "Min new sessions", min: 1, description: "New struggle sessions required since the last dream before another runs." },
      { key: "minGapHours", type: "number", label: "Min gap (hours)", min: 0, description: "Minimum hours between two dreams." },
      { key: "model", type: "string", label: "Dream model", description: "Optional provider/model for the dream child (empty = session default)." },
      {
        key: "thinking",
        type: "enum",
        label: "Thinking level",
        options: [
          { value: "off", label: "off", description: "No thinking." },
          { value: "low", label: "low", description: "Brief thinking." },
          { value: "medium", label: "medium", description: "Default balance." },
          { value: "high", label: "high", description: "Deeper reasoning." },
        ],
        description: "The dream child's thinking level.",
      },
      { key: "skillsTarget", type: "string", label: "Skills target dir", description: "Where approved crafted skills are copied (project-relative)." },
      { key: "maxRuntimeMin", type: "number", label: "Max runtime (min)", min: 5, description: "Hard cap for one dream run." },
    ],
  },
];

registerSettings({
  namespace: NAMESPACE,
  label: "Dream",
  defaults: { ...DEFAULT_DREAM },
  schema: SECTIONS,
});

/** Parse a raw settings record into a complete DreamSettings (tolerant). */
export function normalizeDream(raw: Record<string, unknown> | null | undefined): DreamSettings {
  if (!raw) return { ...DEFAULT_DREAM };
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const str = (v: unknown, d: string): string => (typeof v === "string" && v.trim() ? v.trim() : d);
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_DREAM.enabled,
    minSessions: Math.max(1, num(raw.minSessions, DEFAULT_DREAM.minSessions)),
    minGapHours: num(raw.minGapHours, DEFAULT_DREAM.minGapHours),
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    thinking: str(raw.thinking, DEFAULT_DREAM.thinking),
    skillsTarget: str(raw.skillsTarget, DEFAULT_DREAM.skillsTarget),
    maxRuntimeMin: Math.max(5, num(raw.maxRuntimeMin, DEFAULT_DREAM.maxRuntimeMin)),
  };
}
