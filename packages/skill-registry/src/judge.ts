/**
 * @pi-unipi/skill-registry — skill exposure judging
 *
 * mode "judged": on the session's first REAL prompt (greetings don't count),
 * if more skills are available than `maxSkills`, pick the listed set and
 * freeze it for the session — the rendered system prompt then stays
 * byte-identical every turn (prefix cache intact).
 *
 * Picking:
 *   1. Pins — a skill whose name, or a distinctive word of it, appears in the
 *      prompt is always kept. No model needed ("ssh into coffee" → coffee-sandbox).
 *   2. jev scores every remaining skill against the prompt; ≥ threshold stay,
 *      best first, at most GENERIC_CAP of the generic workflow skills.
 *   3. Everything else is hidden — but NAMED in a static "other installed
 *      skills" section with where each lives, so the model knows it exists.
 * Later prompts: pinned or (with recheck) jev-relevant hidden skills are
 * announced in a message; the system prompt never changes after the freeze.
 */

import { basename, dirname } from "node:path";
import { homedir } from "node:os";
import { askJev, isChatter, resolveDecisionModel, type JevAnswer } from "@pi-unipi/core";
import { isWorkflowSkill, skillDir, type CatalogSkill } from "./registry.js";
import type { ExposureSettings } from "./settings.js";

/** Session-persisted entry types (pi.appendEntry custom entries). */
export const SKILLS_JUDGED_ENTRY = "unipi:skills-judged";
export const SKILLS_REVEALED_ENTRY = "unipi:skills-revealed";
/** System-prompt section naming the hidden skills. */
export const HIDDEN_SECTION = "unipi-skills-hidden";
/** At most this many generic workflow skills (brainstorm, work, …) by score. */
export const GENERIC_CAP = 4;
/** At most this many skills announced per later prompt. */
export const REVEAL_CAP = 5;

export interface Entry {
  name: string;
  description: string;
  location: string;
}

export function toEntry(s: CatalogSkill): Entry {
  return { name: s.name, description: s.description, location: skillDir(s) };
}

// ─── pins ─────────────────────────────────────────────────────────────────

/** Words too common to identify a skill on their own. */
const COMMON = new Set([
  "work", "create", "list", "show", "find", "help", "test", "tests", "mode", "auto", "quick", "review",
  "execute", "gather", "context", "scan", "issues", "full", "output", "write", "writing", "agent",
  "agents", "user", "with", "your", "from", "this", "that", "into", "gain", "debt", "teach", "plan",
  "check", "tool", "tools", "file", "files", "code", "docs", "task", "tasks", "make", "build",
]);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

export function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[-_\s]+/).filter((t) => t.length >= 4);
}

/**
 * Skills the prompt names: the whole name ("coffee-sandbox" / "coffee
 * sandbox"), or a distinctive name word — ≥4 letters, in exactly one skill
 * name, not a common word ("coffee" → coffee-sandbox, "kanboard").
 */
export function pinnedSkills(entries: readonly Entry[], prompt: string): Set<string> {
  const lower = ` ${prompt.toLowerCase().replace(/\s+/g, " ")} `;
  const promptWords = words(prompt);
  const freq = new Map<string, number>();
  for (const e of entries) for (const t of new Set(nameTokens(e.name))) freq.set(t, (freq.get(t) ?? 0) + 1);
  const pins = new Set<string>();
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (lower.includes(`/skill:${n}`)) {
      pins.add(e.name);
      continue;
    }
    // A one-word name that is also a common word ("work", "plan") is not a
    // mention; hyphenated names and uncommon single words are.
    const nameable = n.includes("-") || !COMMON.has(n);
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (nameable && (lower.includes(` ${n.replace(/-/g, " ")} `) || new RegExp(`[^a-z0-9-]${escaped}[^a-z0-9-]`).test(lower))) {
      pins.add(e.name);
      continue;
    }
    if (nameTokens(e.name).some((t) => !COMMON.has(t) && freq.get(t) === 1 && promptWords.has(t))) pins.add(e.name);
  }
  return pins;
}

// ─── jev ──────────────────────────────────────────────────────────────────

export function judgeRequest(
  entries: readonly Entry[],
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
 * Pins always stay; others need ≥ threshold, best first, generic workflow
 * skills capped at GENERIC_CAP, total capped at maxSkills (pins may exceed
 * it — they were asked for by name). Kept set returned in catalog order.
 */
export function applyJudgement(
  entries: readonly Entry[],
  answers: Record<string, JevAnswer> | null,
  settings: Pick<ExposureSettings, "threshold" | "maxSkills">,
  pins: ReadonlySet<string> = new Set(),
): { kept: Entry[]; hidden: Entry[] } {
  const scored = entries.map((entry, i) => ({
    entry,
    score: typeof answers?.[`s${i}`]?.noul === "number" ? (answers[`s${i}`]!.noul as number) : 0,
  }));
  const keep = new Set<Entry>(entries.filter((e) => pins.has(e.name)));
  let generic = [...keep].filter((e) => isWorkflowSkill(e.location)).length;
  for (const { entry, score } of scored.filter((s) => !keep.has(s.entry) && s.score >= settings.threshold).sort((a, b) => b.score - a.score)) {
    if (keep.size >= Math.max(1, settings.maxSkills)) break;
    if (isWorkflowSkill(entry.location)) {
      if (generic >= GENERIC_CAP) continue;
      generic++;
    }
    keep.add(entry);
  }
  return { kept: entries.filter((e) => keep.has(e)), hidden: entries.filter((e) => !keep.has(e)) };
}

// ─── hidden index ─────────────────────────────────────────────────────────

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Static section naming every hidden skill, grouped by the folder that holds
 * it (`<folder>/<name>/SKILL.md`), so the model can load one on demand.
 */
export function hiddenIndex(hidden: readonly Entry[]): string {
  if (hidden.length === 0) return "";
  const groups = new Map<string, string[]>();
  const odd: string[] = [];
  for (const e of [...hidden].sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.location && basename(e.location) === e.name) {
      const parent = tilde(dirname(e.location));
      groups.set(parent, [...(groups.get(parent) ?? []), e.name]);
    } else {
      odd.push(`${e.name} (${tilde(e.location)}/SKILL.md)`);
    }
  }
  const lines = [
    `Other installed skills — not listed above for this session, but available. To use one, read <folder>/<name>/SKILL.md, or tell the user it can be run as /skill:<name>.`,
  ];
  for (const [folder, names] of groups) lines.push(`- ${folder}/: ${names.join(", ")}`);
  for (const o of odd) lines.push(`- ${o}`);
  return lines.join("\n");
}

// ─── per-session frozen state ────────────────────────────────────────────

export interface SessionSkillsState {
  sessionId: string;
  judged: boolean;
  kept: string[];
  hidden: Entry[];
  /** The hidden index as frozen (must stay byte-identical). */
  index: string;
  revealed: Set<string>;
}

export function emptyState(sessionId: string): SessionSkillsState {
  return { sessionId, judged: false, kept: [], hidden: [], index: "", revealed: new Set() };
}

/** Rebuild the frozen state from session entries (resume / fork / reload). */
export function restoreState(sessionId: string, entries: ReadonlyArray<object>): SessionSkillsState {
  const state = emptyState(sessionId);
  for (const entry of entries) {
    const { customType, data } = entry as { customType?: string; data?: Record<string, unknown> };
    if (customType === SKILLS_JUDGED_ENTRY && Array.isArray(data?.kept) && Array.isArray(data?.hidden)) {
      state.judged = true;
      state.kept = data.kept.map(String);
      state.hidden = (data.hidden as Entry[]).map((h) => ({
        name: String(h.name ?? ""),
        description: String(h.description ?? ""),
        location: String(h.location ?? ""),
      }));
      state.index = typeof data.index === "string" ? data.index : "";
      state.revealed = new Set();
    } else if (customType === SKILLS_REVEALED_ENTRY && Array.isArray(data?.names)) {
      for (const name of data.names) state.revealed.add(String(name));
    }
  }
  return state;
}

// ─── the per-turn decision ───────────────────────────────────────────────

export interface TurnInput {
  prompt: string;
  /** Skills available this turn after the registry (listed candidates). */
  catalog: readonly Entry[];
  settings: ExposureSettings;
  cwd: string;
  state: SessionSkillsState;
  /** jev transport; injected in tests. */
  ask?: (req: { state: string; questions: Record<string, unknown> }) => Promise<Record<string, JevAnswer> | null>;
}

export interface TurnOutput {
  /** Names to list this turn. */
  listed: Set<string>;
  /** Hidden-skills section text ("" = none). */
  index: string;
  /** Skills to announce in a message this turn. */
  reveal: Entry[];
  /** Freeze record to persist (first judged turn only). */
  freeze?: { kept: string[]; hidden: Entry[]; index: string; failOpen?: boolean };
  status?: string;
}

export async function decideTurn(input: TurnInput): Promise<TurnOutput> {
  const { prompt, catalog, settings, state } = input;
  const all = new Set(catalog.map((e) => e.name));
  const ask = input.ask ?? ((req) => askJev({ ...req, settings: resolveDecisionModel(input.cwd, "skills"), env: process.env }));

  if (!state.judged) {
    if (catalog.length <= settings.maxSkills) return { listed: all, index: "", reveal: [] };
    if (isChatter(prompt)) return { listed: all, index: "", reveal: [], status: "skills: waiting for a real request" };
    const pins = pinnedSkills(catalog, prompt);
    const answers = await ask(judgeRequest(catalog, prompt, basename(input.cwd)));
    const failOpen = answers === null;
    const { kept, hidden } = failOpen ? { kept: [...catalog], hidden: [] } : applyJudgement(catalog, answers, settings, pins);
    const index = hiddenIndex(hidden);
    state.judged = true;
    state.kept = kept.map((e) => e.name);
    state.hidden = hidden;
    state.index = index;
    return {
      listed: new Set(state.kept),
      index,
      reveal: [],
      freeze: { kept: state.kept, hidden, index, ...(failOpen ? { failOpen: true } : {}) },
      status: `skills: ${kept.length}/${catalog.length} listed`,
    };
  }

  // Frozen: re-apply the same set and the same index; announcements only.
  const listed = new Set(state.kept.filter((n) => all.has(n)));
  const candidates = state.hidden.filter((h) => all.has(h.name) && !state.revealed.has(h.name));
  const reveal: Entry[] = [];
  if (candidates.length > 0 && !isChatter(prompt)) {
    const pins = pinnedSkills(candidates, prompt);
    reveal.push(...candidates.filter((c) => pins.has(c.name)));
    if (settings.recheck && reveal.length < REVEAL_CAP) {
      const rest = candidates.filter((c) => !pins.has(c.name));
      const answers = rest.length ? await ask(judgeRequest(rest, prompt, basename(input.cwd))) : null;
      if (answers) {
        rest.forEach((c, i) => {
          const score = answers[`s${i}`]?.noul;
          if (typeof score === "number" && score >= Math.max(settings.threshold, 0.6)) reveal.push(c);
        });
      }
    }
  }
  const announced = reveal.slice(0, REVEAL_CAP);
  for (const r of announced) state.revealed.add(r.name);
  return { listed, index: state.index, reveal: announced, status: `skills: ${listed.size}/${listed.size + state.hidden.length} listed` };
}

export function revealMessage(reveal: readonly Entry[]): string {
  return (
    `Relevant skills for this request (not in your skills list):\n` +
    reveal.map((r) => `- ${r.name} — ${r.description.slice(0, 200)} (${tilde(r.location)}/SKILL.md)`).join("\n") +
    `\nRead a skill's SKILL.md before using it.`
  );
}
