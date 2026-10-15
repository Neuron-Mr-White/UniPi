/**
 * @pi-unipi/core — skill visibility conditions (UNI-300)
 *
 * A generic, tiny gate any module can use to hide one of its bundled
 * skills from the model when some runtime fact says it can't be used
 * right now (e.g. the PC's browser is off). Skill-registry (and anything
 * else shaping `options.skills`) calls `skillConditionsPass` per skill
 * name; a module that owns the fact calls `registerSkillCondition` once
 * at load time with a cheap, synchronous predicate.
 *
 * Deliberately process-global like the rest of core's small registries
 * (command-runner, settings): modules load once per process, and this
 * needs no session/ctx threading. A condition must never throw or block;
 * callers treat a throwing condition as "false" (hidden) defensively but
 * conditions should fail open themselves when unsure.
 */

export type SkillCondition = () => boolean;

const conditions = new Map<string, SkillCondition>();

/** Registers (or replaces) the visibility condition for a skill name. */
export function registerSkillCondition(skillName: string, condition: SkillCondition): void {
  conditions.set(skillName, condition);
}

export function unregisterSkillCondition(skillName: string): void {
  conditions.delete(skillName);
}

/** True when the skill has no registered condition, or its condition returns true. A throwing
 *  condition counts as false (hidden) — safer than crashing the turn to show a broken skill. */
export function skillConditionPasses(skillName: string): boolean {
  const condition = conditions.get(skillName);
  if (!condition) return true;
  try {
    return condition();
  } catch {
    return false;
  }
}

/** Reason a skill is currently hidden (for a clear `/skill:name` refusal), or undefined when
 *  it isn't gated by a condition, or its condition is registered but no reason was given. */
export type SkillConditionReason = () => string | undefined;

const reasons = new Map<string, SkillConditionReason>();

/** Optional: a human reason shown when `/skill:name` is blocked because the condition is false. */
export function registerSkillConditionReason(skillName: string, reason: SkillConditionReason): void {
  reasons.set(skillName, reason);
}

export function skillConditionReason(skillName: string): string | undefined {
  const fn = reasons.get(skillName);
  if (!fn) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Test hook. */
export function resetSkillConditionsForTests(): void {
  conditions.clear();
  reasons.clear();
}
