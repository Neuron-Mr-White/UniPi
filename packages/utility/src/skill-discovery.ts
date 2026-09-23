/**
 * @pi-unipi/utility — Skill Startup Discovery Gate
 *
 * Controls whether discovered skills are cataloged in the agent's system
 * prompt at session start. Setting: `skills.discovery` in the utility
 * namespace (engine; migrated from the legacy `unipi.skills.discovery` pi
 * settings.json key on first read — default: true).
 *
 * When off, the `<available_skills>` section is stripped from the system
 * prompt every turn. Skills remain invocable via `/skill:name` — pi expands
 * those commands by reading SKILL.md directly from disk, independent of the
 * prompt catalog.
 */

import { getSettings } from "@pi-unipi/core";

/** Skill discovery settings */
export interface SkillDiscoverySettings {
  /** Catalog skills in the system prompt at startup (default: true) */
  discovery: boolean;
}

/** Default skill discovery settings */
export const DEFAULT_SKILL_DISCOVERY_SETTINGS: SkillDiscoverySettings = {
  discovery: true,
};

/** System-prompt markers for the skills catalog (agentskills.io tags). */
const SKILLS_OPEN_TAG = "<available_skills>";
const SKILLS_CLOSE_TAG = "</available_skills>";

/**
 * Load skill discovery settings from the engine (utility namespace). The
 * one-time legacy import lives in settings.ts; defaults apply when unset.
 */
export function loadSkillDiscoverySettings(): SkillDiscoverySettings {
  try {
    const parsed = getSettings("utility", process.cwd()) as {
      skills?: { discovery?: unknown };
    };
    return {
      discovery:
        typeof parsed?.skills?.discovery === "boolean"
          ? parsed.skills.discovery
          : DEFAULT_SKILL_DISCOVERY_SETTINGS.discovery,
    };
  } catch {
    return { ...DEFAULT_SKILL_DISCOVERY_SETTINGS };
  }
}

/**
 * Whether skills are cataloged in the system prompt at startup.
 */
export function isSkillDiscoveryEnabled(): boolean {
  return loadSkillDiscoverySettings().discovery;
}

/**
 * Match a skill location that belongs to Unipi's own bundled skills.
 *
 * - Installed via npm: `…/node_modules/@pi-unipi/<pkg>/skills/…`
 * - Dev checkout (workspace/mise run): `…/unipi/packages/<pkg>/skills/…`
 *
 * Everything else (user global, project, settings-mounted, third-party
 * packages) is NOT considered bundled and stays discoverable.
 */
export function isBundledSkillLocation(location: string): boolean {
  return location.includes("/@pi-unipi/") || /\/unipi\/packages\//.test(location);
}

/**
 * Remove Unipi's bundled skills from the `<available_skills>` catalog in a
 * system prompt, keeping every other skill discoverable. When no non-bundled
 * skills remain, the whole section (with its intro paragraph) is removed.
 *
 * Anchor-based: section tags are agentskills.io spec (stable), entry
 * splitting follows pi's `formatSkillsForPrompt` layout (`  <skill>` entries
 * with `<name>`/`<description>`/`<location>` children).
 *
 * Returns undefined when there is nothing to change (no section, or no
 * bundled skills in it).
 */
export function stripBundledSkills(systemPrompt: string): string | undefined {
  const open = systemPrompt.indexOf(SKILLS_OPEN_TAG);
  if (open === -1) return undefined;
  const close = systemPrompt.indexOf(SKILLS_CLOSE_TAG, open);
  if (close === -1) return undefined;
  const sectionStart = open + SKILLS_OPEN_TAG.length;

  const inner = systemPrompt.slice(sectionStart, close);
  const entries = inner.split(/(?=  <skill>)/g);
  const kept: string[] = [];
  let bundledCount = 0;
  for (const entry of entries) {
    if (!entry.includes("<skill>")) continue; // Whitespace between tags.
    const locationMatch = entry.match(/<location>([^<]*)<\/location>/);
    if (locationMatch && isBundledSkillLocation(locationMatch[1])) {
      bundledCount++;
      continue;
    }
    kept.push(entry);
  }

  if (bundledCount === 0) return undefined; // No bundled skills — no-op.

  if (kept.length === 0) {
    // Nothing left to catalog — remove the entire section (intro included).
    // Layout: "<prev>\n\n<intro paragraph>\n\n<available_skills>…</available_skills>".
    const p1 = systemPrompt.lastIndexOf("\n\n", open);
    const prev = p1 === -1 ? -1 : systemPrompt.lastIndexOf("\n\n", p1 - 1);
    const start = prev === -1 ? 0 : prev;
    return systemPrompt.slice(0, start) + systemPrompt.slice(close + SKILLS_CLOSE_TAG.length);
  }

  // Rebuild the catalog with only the non-bundled entries.
  const rebuiltInner = "\n" + kept.join("").replace(/\n+$/, "") + "\n";
  return systemPrompt.slice(0, sectionStart) + rebuiltInner + systemPrompt.slice(close);
}
