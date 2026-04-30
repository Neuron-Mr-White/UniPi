/**
 * Preset definitions + detection for compactor config
 */

import { createHash } from "node:crypto";
import type { CompactorConfig, CompactorPreset } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./schema.js";

const preset = (
  overrides: Partial<CompactorConfig>,
): CompactorConfig => ({
  ...structuredClone(DEFAULT_COMPACTOR_CONFIG),
  ...overrides,
  sessionGoals: { ...DEFAULT_COMPACTOR_CONFIG.sessionGoals, ...(overrides.sessionGoals as any) },
  filesAndChanges: { ...DEFAULT_COMPACTOR_CONFIG.filesAndChanges, ...(overrides.filesAndChanges as any) },
  commits: { ...DEFAULT_COMPACTOR_CONFIG.commits, ...(overrides.commits as any) },
  outstandingContext: { ...DEFAULT_COMPACTOR_CONFIG.outstandingContext, ...(overrides.outstandingContext as any) },
  userPreferences: { ...DEFAULT_COMPACTOR_CONFIG.userPreferences, ...(overrides.userPreferences as any) },
  briefTranscript: { ...DEFAULT_COMPACTOR_CONFIG.briefTranscript, ...(overrides.briefTranscript as any) },
  sessionContinuity: { ...DEFAULT_COMPACTOR_CONFIG.sessionContinuity, ...(overrides.sessionContinuity as any) },
  fts5Index: { ...DEFAULT_COMPACTOR_CONFIG.fts5Index, ...(overrides.fts5Index as any) },
  sandboxExecution: { ...DEFAULT_COMPACTOR_CONFIG.sandboxExecution, ...(overrides.sandboxExecution as any) },
  toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, ...(overrides.toolDisplay as any) },
});

// Pipeline feature defaults per preset:
// precise: ttlCache+mmap on, rest off
// balanced: all on
// thorough: all on
// lean: all off

export const PRESET_CONFIGS: Record<CompactorPreset, CompactorConfig> = {
  // New preset names
  precise: preset({
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, mode: "opencode" },
  }),
  thorough: preset({
    briefTranscript: { ...DEFAULT_COMPACTOR_CONFIG.briefTranscript, mode: "full" },
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, mode: "verbose" },
  }),
  lean: preset({
    sessionGoals: { ...DEFAULT_COMPACTOR_CONFIG.sessionGoals, enabled: true, mode: "brief" },
    filesAndChanges: { ...DEFAULT_COMPACTOR_CONFIG.filesAndChanges, enabled: true, mode: "modified-only" },
    commits: { ...DEFAULT_COMPACTOR_CONFIG.commits, enabled: false, mode: "off" },
    outstandingContext: { ...DEFAULT_COMPACTOR_CONFIG.outstandingContext, enabled: true, mode: "critical-only" },
    userPreferences: { ...DEFAULT_COMPACTOR_CONFIG.userPreferences, enabled: false, mode: "off" },
    briefTranscript: { ...DEFAULT_COMPACTOR_CONFIG.briefTranscript, enabled: true, mode: "minimal" },
    sessionContinuity: { ...DEFAULT_COMPACTOR_CONFIG.sessionContinuity, enabled: false, mode: "off" },
    fts5Index: { ...DEFAULT_COMPACTOR_CONFIG.fts5Index, enabled: false, mode: "off" },
    sandboxExecution: { ...DEFAULT_COMPACTOR_CONFIG.sandboxExecution, enabled: false, mode: "off" },
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, enabled: true, mode: "opencode" },
  }),
  balanced: preset({
    briefTranscript: { ...DEFAULT_COMPACTOR_CONFIG.briefTranscript, mode: "compact" },
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, mode: "balanced" },
    fts5Index: { ...DEFAULT_COMPACTOR_CONFIG.fts5Index, mode: "auto" },
  }),

  // Backward-compat aliases — map old names to new
  opencode: preset({
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, mode: "opencode" },
  }),
  verbose: preset({
    briefTranscript: { ...DEFAULT_COMPACTOR_CONFIG.briefTranscript, mode: "full" },
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, mode: "verbose" },
  }),
  minimal: preset({
    sessionGoals: { ...DEFAULT_COMPACTOR_CONFIG.sessionGoals, enabled: true, mode: "brief" },
    filesAndChanges: { ...DEFAULT_COMPACTOR_CONFIG.filesAndChanges, enabled: true, mode: "modified-only" },
    commits: { ...DEFAULT_COMPACTOR_CONFIG.commits, enabled: false, mode: "off" },
    outstandingContext: { ...DEFAULT_COMPACTOR_CONFIG.outstandingContext, enabled: true, mode: "critical-only" },
    userPreferences: { ...DEFAULT_COMPACTOR_CONFIG.userPreferences, enabled: false, mode: "off" },
    briefTranscript: { ...DEFAULT_COMPACTOR_CONFIG.briefTranscript, enabled: true, mode: "minimal" },
    sessionContinuity: { ...DEFAULT_COMPACTOR_CONFIG.sessionContinuity, enabled: false, mode: "off" },
    fts5Index: { ...DEFAULT_COMPACTOR_CONFIG.fts5Index, enabled: false, mode: "off" },
    sandboxExecution: { ...DEFAULT_COMPACTOR_CONFIG.sandboxExecution, enabled: false, mode: "off" },
    toolDisplay: { ...DEFAULT_COMPACTOR_CONFIG.toolDisplay, enabled: true, mode: "opencode" },
  }),
  custom: structuredClone(DEFAULT_COMPACTOR_CONFIG),
};

// Pre-computed identity hashes for fast preset detection
const presetHashes = new Map<string, string>();

function presetHash(config: CompactorConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

// Compute hashes once at module load
for (const name of ["precise", "balanced", "thorough", "lean"] as const) {
  presetHashes.set(name, presetHash(PRESET_CONFIGS[name]));
}

function configsEqual(a: CompactorConfig, b: CompactorConfig): boolean {
  // Fast path: hash comparison
  const aHash = presetHash(a);
  const bHash = presetHash(b);
  if (aHash !== bHash) return false;
  // Defensive: confirm with full comparison
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Detect which preset a config matches, or "custom".
 */
export function detectPreset(config: CompactorConfig): CompactorPreset {
  const configHash = presetHash(config);
  for (const name of ["precise", "balanced", "thorough", "lean"] as const) {
    if (presetHashes.get(name) === configHash && configsEqual(config, PRESET_CONFIGS[name])) {
      return name;
    }
  }
  return "custom";
}

/**
 * Apply a preset to a config.
 */
export function applyPreset(name: CompactorPreset): CompactorConfig {
  return structuredClone(PRESET_CONFIGS[name]);
}

// Old → new preset name mapping for backward compatibility
const OLD_TO_NEW: Record<string, CompactorPreset> = {
  opencode: "precise",
  verbose: "thorough",
  minimal: "lean",
};

/**
 * Parse a preset name (case-insensitive). Old names are mapped to new with deprecation.
 */
export function parsePreset(raw: string): CompactorPreset | undefined {
  const normalized = raw.trim().toLowerCase();

  // Check new names first
  if (normalized === "precise" || normalized === "balanced" || normalized === "thorough" || normalized === "lean" || normalized === "custom") {
    return normalized;
  }

  // Map old names to new (backward compat)
  if (OLD_TO_NEW[normalized]) {
    return OLD_TO_NEW[normalized];
  }

  return undefined;
}
