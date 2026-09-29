/**
 * @pi-unipi/skill-registry — per-skill state resolution (pure)
 *
 * Defaults: pi-discovered skills are on and listed; vault skills are off
 * until a scope turns them on. Explicit states from the merged settings
 * (project over global) override the defaults.
 */

import { homedir } from "node:os";
import type { SkillState } from "./settings.js";

/** The slice of pi's Skill the registry needs. */
export interface CatalogSkill {
  name: string;
  description: string;
  filePath?: string;
  baseDir?: string;
}

export type SkillSource = "vault" | "project" | "user" | "unipi" | "package";

export function skillDir(s: CatalogSkill): string {
  return s.baseDir ?? (s.filePath ? s.filePath.replace(/\/SKILL\.md$/, "") : "");
}

export function isUnderDir(path: string, dir: string): boolean {
  const d = dir.endsWith("/") ? dir : `${dir}/`;
  return path === dir || path.startsWith(d);
}

/** Unipi's own bundled skills (npm install or dev checkout). */
export function isBundledSkillLocation(location: string): boolean {
  return location.includes("/@pi-unipi/") || /\/unipi\/packages\//.test(location);
}

/** The generic workflow skills shipped in this package (brainstorm, work, …). */
export function isWorkflowSkill(location: string): boolean {
  return /\/(?:@pi-unipi|packages)\/skill-registry\/skills\//.test(location);
}

export function skillSource(s: CatalogSkill, cwd: string, vault: string): SkillSource {
  const dir = skillDir(s);
  if (isUnderDir(dir, vault)) return "vault";
  if (isBundledSkillLocation(dir)) return "unipi";
  if (isUnderDir(dir, cwd)) return "project";
  const home = homedir();
  if (isUnderDir(dir, `${home}/.agents/skills`) || isUnderDir(dir, `${home}/.pi/agent/skills`)) return "user";
  return "package";
}

export interface EffectiveState {
  enabled: boolean;
  mustShow: boolean;
}

export function effectiveState(state: SkillState | undefined, source: SkillSource): EffectiveState {
  const mustShow = state?.mustShow === true;
  // Must show implies enabled and is always listed.
  return { enabled: mustShow || (state?.enabled ?? source !== "vault"), mustShow };
}

export interface RegistryResult<T> {
  /** Listed skills the user pinned ("Must show"): exposure never hides them. */
  mustShow: Set<string>;
  /** Skills listed for the model. */
  listed: T[];
  /** Names removed from the session entirely (/skill:name is blocked too). */
  disabled: Set<string>;
}

export function applyRegistry<T extends CatalogSkill>(
  catalog: readonly T[],
  states: Record<string, SkillState>,
  cwd: string,
  vault: string,
): RegistryResult<T> {
  const listed: T[] = [];
  const disabled = new Set<string>();
  const mustShow = new Set<string>();
  for (const skill of catalog) {
    const eff = effectiveState(states[skill.name], skillSource(skill, cwd, vault));
    if (eff.mustShow) mustShow.add(skill.name);
    if (!eff.enabled) disabled.add(skill.name);
    else listed.push(skill);
  }
  return { listed, disabled, mustShow };
}

/** `/skill:name args` → name, else undefined. */
export function skillCommandName(text: string): string | undefined {
  return text.trim().match(/^\/skill:([a-z0-9][a-z0-9-]*)/i)?.[1];
}
