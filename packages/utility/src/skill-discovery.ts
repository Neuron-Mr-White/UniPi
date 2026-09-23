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

import { basename, join } from "node:path";
import * as path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev, getSettings, readJudgeJevSettings, type JevAnswer, type JevSettings } from "@pi-unipi/core";
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
  return readJudgeJevSettings(process.cwd());
}

/** Debug logging, gated by UNIPI_DEBUG_SKILLS=1 → ~/.unipi/logs/skills.log. */
function debugLog(line: string): void {
  if (process.env.UNIPI_DEBUG_SKILLS !== "1") return;
  try {
    const dir = join(homedir(), ".unipi", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "skills.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Debug logging is best-effort.
  }
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
): SessionSkillsState {
  sessionState = { sessionId, judged: false, hiddenCount: 0, kept: [], hidden: [], revealed: new Set() };
  for (const entry of entries) {
    const customType = (entry as { customType?: string }).customType;
    if (customType !== SKILLS_JUDGED_ENTRY && customType !== SKILLS_REVEALED_ENTRY) continue;
    const data = (entry as { data?: unknown }).data as
      | { kept?: unknown; hidden?: unknown; hiddenCount?: unknown; names?: unknown }
      | undefined;
    if (customType === SKILLS_JUDGED_ENTRY) {
      if (Array.isArray(data?.kept) && Array.isArray(data?.hidden)) {
        // The freeze is authoritative: later turns reuse it (never re-judge).
        sessionState.judged = true;
        sessionState.kept = data.kept.map(String);
        sessionState.hidden = (data.hidden as ParsedSkill[]).map((h) => ({
          name: String(h.name ?? ""),
          description: String(h.description ?? ""),
          location: String(h.location ?? ""),
          raw: "",
        }));
        sessionState.hiddenCount =
          typeof data.hiddenCount === "number" ? data.hiddenCount : sessionState.hidden.length;
      }
    } else if (Array.isArray(data?.names)) {
      for (const name of data.names) sessionState.revealed.add(String(name));
      // Announced skills are no longer recheck candidates.
      sessionState.hidden = sessionState.hidden.filter((h) => !sessionState!.revealed.has(h.name));
    }
  }
  if (sessionState.judged) {
    debugLog(
      `restored frozen set from session entry (kept=${sessionState.kept.length} hidden=${sessionState.hiddenCount})`,
    );
  }
  return sessionState;
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
/**
 * Wire the skills pipeline into pi: session restore + the before_agent_start
 * options mutation (bundled strip → freeze → judge → recheck).
 *
 * Integration note: pi renders the skills catalog from
 * `event.systemPromptOptions.skills` AFTER handlers run, so judging works by
 * MUTATING that array to the frozen exposed set — the system prompt stays
 * byte-identical on every later turn (prefix-cache safe).
 */
/** Event another module emits to force-reveal a skill by name (append-only). */
export const SKILL_REVEAL_EVENT = "unipi:skills:reveal";

/**
 * Reveal skills on request from another module (kanboard's onboard/work).
 * Append-only: the agent gets a message naming the skill and where it lives —
 * the system prompt is never touched, so the prefix cache holds. Returns the
 * names that were newly revealed.
 */
export function revealSkillsByName(
  pi: ExtensionAPI,
  names: readonly string[],
  location: string,
  description: string,
): string[] {
  const state = sessionState;
  const wanted = names.filter((name) => name.trim().length > 0);
  if (!state) return wanted;
  const reveal = (name: string): boolean => {
    if (state.revealed.has(name)) return false;
    state.revealed.add(name);
    state.hidden = state.hidden.filter((entry) => entry.name !== name);
    return true;
  };
  const newly = wanted.filter(reveal);
  if (newly.length === 0) return [];
  pi.appendEntry(SKILLS_REVEALED_ENTRY, { names: newly });
  pi.sendMessage(
    {
      customType: "unipi-skills-revealed",
      content:
        `Skills revealed for this session:\n` +
        newly.map((name) => `- ${name} \u2014 ${description} (${location})`).join("\n") +
        `\nRead a skill's SKILL.md before using it.`,
      display: true,
    },
    { triggerTurn: false },
  );
  return newly;
}

export function registerSkillJudging(pi: ExtensionAPI): void {
  // The fake pi in tests has no event bus; registration must still succeed.
  pi.events?.on?.(SKILL_REVEAL_EVENT, (payload: unknown) => {
    const data = payload as { names?: unknown; location?: unknown; description?: unknown } | undefined;
    if (!Array.isArray(data?.names)) return;
    revealSkillsByName(
      pi,
      data.names.map(String),
      typeof data.location === "string" ? data.location : "skills/",
      typeof data.description === "string" ? data.description : "revealed on request",
    );
  });

  pi.on("session_start", (_event, ctx) => {
    // resume/fork/new: re-derive state from the (possibly branched) entries.
    restoreSkillsSessionState(ctx.sessionManager.getSessionId(), ctx.sessionManager.getEntries());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const st = loadSkillDiscoverySettings();
    const optionSkills = event.systemPromptOptions?.skills ?? [];
    const skillDir = (s: { filePath?: string; baseDir?: string }): string =>
      s.baseDir ?? s.filePath ?? "";
    debugLog(
      `before_agent_start mode=${st.mode} skills=${optionSkills.length} ` +
      `promptChars=${event.systemPrompt.length}`,
    );

    // Bundled stripping runs first, exactly as it always has (mode off).
    if (st.mode === "off") {
      event.systemPromptOptions.skills = optionSkills.filter(
        (s) => !isBundledSkillLocation(skillDir(s)),
      );
      return undefined;
    }
    if (st.mode === "all") {
      return undefined; // every skill stays; nothing to judge
    }

    const state = currentState(ctx);

    // ── judged: freeze on the session's first prompt ──
    if (!state.judged) {
      if (optionSkills.length <= st.maxSkills) {
        // Small catalog: everyone stays; nothing hidden, nothing frozen.
        debugLog(`catalog ${optionSkills.length} <= maxSkills ${st.maxSkills} — not judged`);
        return undefined;
      }
      const entries: ParsedSkill[] = optionSkills.map((s) => ({
        name: s.name,
        description: s.description,
        location: skillDir(s),
        raw: "",
      }));
      const req = judgeRequest(entries, event.prompt, basename(process.cwd()));
      const startedAt = Date.now();
      const answers = await askJev({
        ...req,
        settings: judgeSettings(),
        fetchImpl: undefined,
        env: process.env,
      });
      let kept: ParsedSkill[];
      let hidden: ParsedSkill[];
      let failOpen = false;
      if (answers) {
        ({ kept, hidden } = applyJudgement(entries, answers, st.threshold, st.maxSkills));
      } else {
        kept = entries; // fail-open: expose everything
        hidden = [];
        failOpen = true;
      }
      state.judged = true;
      state.hiddenCount = hidden.length;
      state.kept = kept.map((e) => e.name);
      state.hidden = hidden;
      debugLog(
        `judged ${entries.length} -> ${kept.length} ` +
        `kept=[${kept.map((e) => e.name).join(", ")}] ` +
        `latency=${Date.now() - startedAt}ms failOpen=${failOpen}`,
      );
      pi.appendEntry(SKILLS_JUDGED_ENTRY, {
        kept: state.kept,
        hidden: hidden.map((h) => ({ name: h.name, description: h.description, location: h.location })),
        hiddenCount: hidden.length,
        ...(failOpen ? { failOpen: true } : {}),
      });
      event.systemPromptOptions.skills = optionSkills.filter((s) =>
        kept.some((e) => e.name === s.name),
      );
      if (ctx.hasUI) {
        ctx.ui.setStatus("skills", `skills: ${kept.length}/${entries.length} exposed`);
      }
      return undefined;
    }

    // ── frozen turns: re-apply the frozen exposed set. The system prompt pi
    // renders stays byte-identical every turn; recheck only ADDS a message.
    const keptSet = new Set(state.kept);
    event.systemPromptOptions.skills = optionSkills.filter((s) => keptSet.has(s.name));
    if (ctx.hasUI) {
      ctx.ui.setStatus("skills", `skills: ${state.kept.length}/${state.kept.length + state.hiddenCount} exposed`);
    }

    if (st.recheck && state.hidden.length > 0) {
      const entries: ParsedSkill[] = state.hidden;
      const req = judgeRequest(entries, event.prompt, basename(process.cwd()));
      const answers = await askJev({
        ...req,
        settings: judgeSettings(),
        fetchImpl: undefined,
        env: process.env,
      });
      if (answers) {
        const newly = entries
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

    return undefined;
  });
}