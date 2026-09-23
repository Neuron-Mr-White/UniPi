/**
 * @pi-unipi/utility — Skill startup exposure
 *
 * Decides which discovered skills stay cataloged in the agent's system
 * prompt. Setting: `skills.mode` in the utility namespace:
 *
 *   judged — jev (the long-horizon Decision model) picks the skills whose
 *            descriptions look relevant to the session's first prompt; the
 *            frozen set is reused for every later turn (byte-identical
 *            system prompt, prefix-cache safe). With skills.recheck, later
 *            prompts can ANNOUNCE newly relevant hidden skills via a
 *            persisted custom message — the system prompt itself never
 *            changes after the freeze.
 *   all    — every discovered skill stays (no judging).
 *   off    — bundled skills stripped (old "false" behavior).
 *
 * Skills stay invocable regardless of mode: /skill:name and direct
 * SKILL.md reads are independent of the prompt catalog.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev, getSettings, type JevAnswer, type JevSettings } from "@pi-unipi/core";
import { migrateSkillsDiscovery } from "./settings.js";

export type SkillExposureMode = "judged" | "all" | "off";

/** Skill exposure settings */
export interface SkillDiscoverySettings {
  mode: SkillExposureMode;
  /** Minimum jev relevance (noul 0–1) for a skill to stay exposed. */
  threshold: number;
  /** Hard cap on exposed skills. */
  maxSkills: number;
  /** Suggest newly relevant hidden skills on later prompts. */
  recheck: boolean;
}

/** Default skill exposure settings */
export const DEFAULT_SKILL_DISCOVERY_SETTINGS: SkillDiscoverySettings = {
  mode: "judged",
  threshold: 0.3,
  maxSkills: 12,
  recheck: true,
};

/** Session-persisted entry types (pi.appendEntry custom entries). */
export const SKILLS_JUDGED_ENTRY = "unipi:skills-judged";
export const SKILLS_REVEALED_ENTRY = "unipi:skills-revealed";

/** System-prompt markers for the skills catalog (agentskills.io tags). */
const SKILLS_OPEN_TAG = "<available_skills>";
const SKILLS_CLOSE_TAG = "</available_skills>";

/**
 * Load skill exposure settings from the engine (utility namespace). The
 * one-time migrations live in settings.ts; defaults apply when unset.
 */
export function loadSkillDiscoverySettings(): SkillDiscoverySettings {
  try {
    migrateSkillsDiscovery(process.cwd());
    const parsed = getSettings("utility", process.cwd()) as {
      skills?: Record<string, unknown>;
    };
    const skills = parsed?.skills ?? {};
    return {
      mode:
        skills.mode === "judged" || skills.mode === "all" || skills.mode === "off"
          ? skills.mode
          : skills.discovery === false
            ? "off"
            : DEFAULT_SKILL_DISCOVERY_SETTINGS.mode,
      threshold:
        typeof skills.threshold === "number" && skills.threshold >= 0 && skills.threshold <= 1
          ? skills.threshold
          : DEFAULT_SKILL_DISCOVERY_SETTINGS.threshold,
      maxSkills:
        typeof skills.maxSkills === "number" && skills.maxSkills >= 1
          ? skills.maxSkills
          : DEFAULT_SKILL_DISCOVERY_SETTINGS.maxSkills,
      recheck: typeof skills.recheck === "boolean" ? skills.recheck : DEFAULT_SKILL_DISCOVERY_SETTINGS.recheck,
    };
  } catch {
    return { ...DEFAULT_SKILL_DISCOVERY_SETTINGS };
  }
}

/**
 * Whether skills are cataloged in the system prompt at startup.
 */
export function isSkillDiscoveryEnabled(): boolean {
  return loadSkillDiscoverySettings().mode !== "off";
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

// ─── jev-judged skill exposure ───────────────────────────────────────────

/** One `<skill>` entry from the `<available_skills>` catalog. */
export interface ParsedSkill {
  name: string;
  description: string;
  location: string;
  /** The raw catalog block, reused verbatim when rebuilding the section. */
  raw: string;
}

export interface ParsedCatalog {
  entries: ParsedSkill[];
  /** Prompt text before `<available_skills>` (intro included). */
  before: string;
  /** Prompt text from `</available_skills>` on (exclusive of the tag). */
  after: string;
}

/** Extract the `<available_skills>` entries (name/description/location). */
export function parseSkillsCatalog(systemPrompt: string): ParsedCatalog | null {
  const open = systemPrompt.indexOf(SKILLS_OPEN_TAG);
  if (open === -1) return null;
  const close = systemPrompt.indexOf(SKILLS_CLOSE_TAG, open);
  if (close === -1) return null;
  const sectionStart = open + SKILLS_OPEN_TAG.length;
  const inner = systemPrompt.slice(sectionStart, close);
  const entries: ParsedSkill[] = [];
  for (const block of inner.split(/(?=  <skill>)/g)) {
    if (!block.includes("<skill>")) continue;
    const name = block.match(/<name>([^<]*)<\/name>/)?.[1] ?? "";
    const description = block.match(/<description>([^<]*)<\/description>/)?.[1] ?? "";
    const location = block.match(/<location>([^<]*)<\/location>/)?.[1] ?? "";
    entries.push({ name, description, location, raw: block });
  }
  return {
    entries,
    before: systemPrompt.slice(0, sectionStart),
    after: systemPrompt.slice(close),
  };
}

/** Rebuild the prompt with only `kept` entries, then the hidden-count line. */
export function rebuildSkillsCatalog(
  prompt: string,
  kept: readonly ParsedSkill[],
  hiddenCount: number,
): string {
  const open = prompt.indexOf(SKILLS_OPEN_TAG);
  const close = prompt.indexOf(SKILLS_CLOSE_TAG, open);
  if (open === -1 || close === -1) return prompt;
  const sectionStart = open + SKILLS_OPEN_TAG.length;
  const rebuiltInner =
    "\n" + kept.map((e) => e.raw).join("").replace(/\n+$/, "") + (kept.length > 0 ? "\n" : "");
  const hiddenLine =
    hiddenCount > 0
      ? `\n${hiddenCount} other skills are installed but hidden for this session; any can still be loaded by reading its SKILL.md or via /skill:name.`
      : "";
  return prompt.slice(0, sectionStart) + rebuiltInner + SKILLS_CLOSE_TAG + hiddenLine + prompt.slice(close + SKILLS_CLOSE_TAG.length);
}

/** One Noul question per skill; state is the prompt (truncated) + cwd. */
export function judgeRequest(
  entries: readonly ParsedSkill[],
  prompt: string,
  cwdBase: string,
): { state: string; questions: Record<string, { type: "noul"; instructions: string }> } {
  const state = `${prompt.slice(0, 4000)}\n[project: ${cwdBase}]`;
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  entries.forEach((entry, i) => {
    questions[`s${i}`] = {
      type: "noul",
      instructions: `Would the skill "${entry.name}" help handle this request? Skill: ${entry.description.slice(0, 300)}`,
    };
  });
  return { state, questions };
}

/**
 * Apply jev's answers: keep noul ≥ threshold, sort by score descending, cap
 * at maxSkills, and restore the original catalog order for the kept set.
 */
export function applyJudgement(
  entries: readonly ParsedSkill[],
  answers: Record<string, JevAnswer>,
  threshold: number,
  maxSkills: number,
): { kept: ParsedSkill[]; hidden: ParsedSkill[] } {
  const scored = entries.map((entry, i) => ({
    entry,
    score: typeof answers[`s${i}`]?.noul === "number" ? (answers[`s${i}`].noul as number) : 0,
  }));
  const kept = scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, maxSkills))
    .map((s) => s.entry);
  const keptKeys = new Set(kept);
  return { kept, hidden: entries.filter((e) => !keptKeys.has(e)) };
}

/** The Decision-model settings the skill judge shares with long-horizon. */
function judgeSettings(): JevSettings {
  const raw = getSettings("long-horizon", process.cwd()) as {
    judge?: Record<string, unknown>;
  };
  const j = raw?.judge ?? {};
  return {
    provider: j.provider === "typesafe" ? "typesafe" : "openrouter",
    model: typeof j.model === "string" ? j.model : "",
    baseUrl: typeof j.baseUrl === "string" ? j.baseUrl : "",
    apiKey: typeof j.apiKey === "string" ? j.apiKey : "",
    timeoutMs: typeof j.timeoutMs === "number" ? j.timeoutMs : 0,
  };
}

// ─── per-session frozen state ────────────────────────────────────────────

export interface SessionSkillsState {
  sessionId: string;
  /** Frozen on the session's first judged prompt. */
  judged: boolean;
  /** Hidden-skill count AT FREEZE — the prompt line must stay byte-identical. */
  hiddenCount: number;
  /** Frozen exposed skill names, in catalog order. */
  kept: string[];
  /** Skills hidden by the freeze (recheck candidates). */
  hidden: ParsedSkill[];
  revealed: Set<string>;
}

let sessionState: SessionSkillsState | null = null;

/** Scan session entries for the frozen judged set + already-revealed names. */
export function restoreSkillsSessionState(
  sessionId: string,
  entries: ReadonlyArray<object>,
): void {
  sessionState = { sessionId, judged: false, hiddenCount: 0, kept: [], hidden: [], revealed: new Set() };
  for (const entry of entries) {
    const customType = (entry as { customType?: string }).customType;
    if (customType !== SKILLS_JUDGED_ENTRY && customType !== SKILLS_REVEALED_ENTRY) continue;
    const data = (entry as { data?: unknown }).data as
      | { kept?: unknown; hidden?: unknown; names?: unknown }
      | undefined;
    if (customType === SKILLS_JUDGED_ENTRY) {
      if (Array.isArray(data?.kept) && Array.isArray(data?.hidden)) {
        sessionState.kept = data.kept.map(String);
        sessionState.hidden = (data.hidden as ParsedSkill[]).map((h) => ({
          name: String(h.name ?? ""),
          description: String(h.description ?? ""),
          location: String(h.location ?? ""),
          raw: "",
        }));
      }
    } else if (Array.isArray(data?.names)) {
      for (const name of data.names) sessionState.revealed.add(String(name));
    }
  }
}

/** Drop per-session state (new session). */
export function resetSkillsSessionState(sessionId: string): void {
  sessionState = { sessionId, judged: false, hiddenCount: 0, kept: [], hidden: [], revealed: new Set() };
}

function currentState(ctx: ExtensionContext): SessionSkillsState {
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sessionState || sessionState.sessionId !== sessionId) {
    resetSkillsSessionState(sessionId);
  }
  return sessionState!;
}

/**
 * Wire the skills pipeline into pi: session restore + the before_agent_start
 * system-prompt rewrite (bundled strip → freeze → judge → recheck).
 */
export function registerSkillJudging(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    // resume/fork/new: re-derive state from the (possibly branched) entries.
    restoreSkillsSessionState(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const st = loadSkillDiscoverySettings();
    let prompt = event.systemPrompt;

    // Bundled stripping runs first, exactly as it always has.
    if (st.mode === "off") {
      const stripped = stripBundledSkills(prompt);
      return stripped ? { systemPrompt: stripped } : undefined;
    }
    const stripped = stripBundledSkills(prompt);
    if (stripped) prompt = stripped;

    const state = currentState(ctx);

    if (st.mode === "all") {
      return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
    }

    // ── judged ──
    if (!state.judged) {
      const parsed = parseSkillsCatalog(prompt);
      if (!parsed || parsed.entries.length === 0) {
        return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
      }
      if (parsed.entries.length <= st.maxSkills) {
        // Small catalog: everyone stays; nothing hidden, nothing frozen.
        return prompt === event.systemPrompt ? undefined : { systemPrompt: prompt };
      }
      const req = judgeRequest(parsed.entries, event.prompt, basename(process.cwd()));
      const answers = await askJev({
        ...req,
        settings: judgeSettings(),
        fetchImpl: undefined,
        env: process.env,
      });
      let kept: ParsedSkill[];
      let hidden: ParsedSkill[];
      if (answers) {
        ({ kept, hidden } = applyJudgement(parsed.entries, answers, st.threshold, st.maxSkills));
      } else {
        kept = parsed.entries; // fail-open: expose everything
        hidden = [];
      }
      state.kept = kept.map((e) => e.name);
      state.hidden = hidden;
      state.judged = true;
      state.hiddenCount = hidden.length;
      pi.appendEntry(SKILLS_JUDGED_ENTRY, {
        kept: state.kept,
        hidden: hidden.map((h) => ({ name: h.name, description: h.description, location: h.location })),
      });
      if (hidden.length > 0) {
        prompt = rebuildSkillsCatalog(prompt, kept, hidden.length);
        if (ctx.hasUI) ctx.ui.setStatus("skills", `skills: ${kept.length}/${parsed.entries.length} exposed`);
      }
      return { systemPrompt: prompt };
    }

    // ── frozen turns: ALWAYS override with the frozen exposed set. Returning
    // undefined here would let pi's rebuilt full catalog (all skills) leak
    // back into the prompt and break the prefix-cache guarantee.
    const parsedFrozen = parseSkillsCatalog(prompt);
    if (parsedFrozen) {
      const keptSet = new Set(state.kept);
      const kept = parsedFrozen.entries.filter((e) => keptSet.has(e.name));
      prompt = rebuildSkillsCatalog(prompt, kept, state.hiddenCount);
    }

    if (st.recheck && state.hidden.length > 0) {
      const req = judgeRequest(state.hidden, event.prompt, basename(process.cwd()));
      const answers = await askJev({
        ...req,
        settings: judgeSettings(),
        fetchImpl: undefined,
        env: process.env,
      });
      if (answers) {
        const newly = state.hidden
          .filter((h, i) => {
            const score = answers[`s${i}`]?.noul;
            return typeof score === "number" && score >= st.threshold && !state.revealed.has(h.name);
          })
          .slice(0, 5);
        if (newly.length > 0) {
          for (const skill of newly) state.revealed.add(skill.name);
          state.hidden = state.hidden.filter((h) => !newly.includes(h));
          pi.appendEntry(SKILLS_REVEALED_ENTRY, { names: newly.map((n) => n.name) });
          return {
            systemPrompt: prompt,
            message: {
              customType: "unipi-skills-revealed",
              content:
                `Newly relevant skills for this request:\n` +
                newly.map((n) => `- ${n.name} \u2014 ${n.description} (${n.location})`).join("\n") +
                `\nRead a skill's SKILL.md before using it.`,
              display: true,
            },
          };
        }
      }
    }

    return { systemPrompt: prompt };
  });
}