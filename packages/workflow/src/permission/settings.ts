/**
 * Permission settings — the `permission` namespace, its hub schema, and the
 * rule store helpers.
 */

import {
  getSettings,
  getSettingsScoped,
  registerSettings,
  setSettings,
  settingsLayers,
  type SettingsSection,
  decisionModelSection,
  DEFAULT_DECISION_OVERRIDE,
} from "@pi-unipi/core";
import { normalizeRules, type PermissionRule } from "./rules.js";

export type PermissionMode = "ask" | "auto" | "full";

export interface PermissionSettings {
  mode: PermissionMode;
  defaultMode: PermissionMode;
  jevConfidence: number;
  rules: PermissionRule[];
}

export const DEFAULT_SETTINGS = {
  mode: "auto",
  defaultMode: "auto",
  jevConfidence: 0.7,
  rules: [] as PermissionRule[],
} satisfies PermissionSettings;

const MODE_OPTIONS = [
  { value: "ask", label: "ask", description: "prompt for everything not explicitly allowed" },
  { value: "auto", label: "auto", description: "allow safe calls; jev judges ambiguous bash" },
  { value: "full", label: "full", description: "allow everything except saved deny rules" },
] as const;

export const PERMISSION_SECTIONS: SettingsSection[] = [
  {
    title: "Permissions",
    description: "Tool-call gate: ask, auto (jev judges ambiguous bash), or full.",
    fields: [
      {
        key: "mode",
        type: "enum",
        label: "Mode here",
        options: MODE_OPTIONS.map((o) => ({ ...o })),
        clearable: true,
        scopes: ["project"],
        description: "Tool-call gate for this project. Alt+M cycles it.",
      },
      {
        key: "defaultMode",
        type: "enum",
        label: "Default mode",
        scope: "global",
        options: MODE_OPTIONS.map((o) => ({ ...o })),
        description: "Mode for projects that set none of their own.",
      },
      {
        key: "jevConfidence",
        type: "number",
        label: "Minimum jev confidence",
        min: 0,
        max: 1,
        description: "Auto mode accepts a 'safe' jev verdict at or above this confidence; below it, the call prompts.",
      },
      {
        key: "rulesCount",
        type: "action",
        label: "Clear saved rules…",
        description: "Forget every allow/deny rule saved for this project.",
        command: "unipi:permission-clear-rules",
      },
    ],
  },
  decisionModelSection({ title: "Auto mode — Decision model" }),
];

export function registerPermissionSettings(cwd?: string): void {
  // One-time, idempotent migration: an existing global `mode` (pre-defaultMode
  // installs) is copied to `defaultMode` so the hub shows it instead of "unset".
  if (cwd) {
    const global = getSettingsScoped("permission", "global", cwd);
    if (global && typeof global.mode === "string" && global.defaultMode === undefined) {
      setSettings("permission", { defaultMode: global.mode }, "global", cwd);
    }
  }
  const count = cwd ? readPermissionSettings(cwd).rules.length : 0;
  registerSettings({
    namespace: "permission",
    label: "Permissions",
    defaults: { ...DEFAULT_SETTINGS, decisionModel: DEFAULT_DECISION_OVERRIDE } as unknown as Record<string, unknown>,
    schema: PERMISSION_SECTIONS.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        field.type === "action" && field.key === "rulesCount"
          ? { ...field, label: count === 0 ? "Clear saved rules…" : `Clear ${count} saved rule${count === 1 ? "" : "s"}…` }
          : field,
      ),
    })),
  });
}

function coerceMode(value: unknown): PermissionMode {
  return value === "ask" || value === "full" ? value : "auto";
}

export function readPermissionSettings(cwd: string): PermissionSettings {
  const raw = getSettings("permission", cwd);
  return {
    mode: effectivePermissionMode(cwd),
    defaultMode: coerceMode(raw.defaultMode),
    jevConfidence:
      typeof raw.jevConfidence === "number" && raw.jevConfidence >= 0 && raw.jevConfidence <= 1
        ? raw.jevConfidence
        : DEFAULT_SETTINGS.jevConfidence,
    rules: normalizeRules(raw.rules),
  };
}

/** project `mode` → global `defaultMode` → legacy global `mode` → auto. */
export function effectivePermissionMode(cwd: string): PermissionMode {
  const project = getSettingsScoped("permission", "project", cwd);
  if (project && typeof project.mode === "string") return coerceMode(project.mode);
  const global = getSettingsScoped("permission", "global", cwd);
  if (global && typeof global.defaultMode === "string") return coerceMode(global.defaultMode);
  if (global && typeof global.mode === "string") return coerceMode(global.mode); // legacy installs
  return "auto";
}

/** Written to the project scope: the mode is a property of the workspace. */
export function writePermissionMode(mode: PermissionMode, cwd: string): void {
  setSettings("permission", { mode }, "project", cwd);
}

export function addPermissionRule(rule: PermissionRule, cwd: string): void {
  const { rules } = readPermissionSettings(cwd);
  const withoutDuplicate = rules.filter(
    (existing) => !(existing.tool === rule.tool && existing.pattern === rule.pattern),
  );
  setSettings("permission", { rules: [...withoutDuplicate, rule] }, rule.scope, cwd);
  registerPermissionSettings(cwd);
}

export function clearPermissionRules(cwd: string): number {
  const { rules } = readPermissionSettings(cwd);
  setSettings("permission", { rules: [] }, "project", cwd);
  // Only touch a global layer that already exists — clearing must not create one.
  if (settingsLayers("permission", cwd).global) {
    setSettings("permission", { rules: [] }, "global", cwd);
  }
  registerPermissionSettings(cwd);
  return rules.length;
}
