/**
 * jev-judged skill exposure — end-to-end through the before_agent_start hook
 * with a fake pi/ctx, a stubbed global fetch, and a sandboxed engine.
 *
 * Guarantees under test:
 *   1. catalog parse/rebuild keeps original order + adds the hidden-count line
 *   2. threshold + cap + sort by score
 *   3. fail-open (null answer, timeout, missing key) exposes all skills
 *   4. count ≤ maxSkills never calls jev
 *   5. the system prompt is byte-identical on later turns, including after a
 *      simulated reload from the persisted session entry
 *   6. recheck reveals hidden skills once, without touching the system prompt
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyJudgement,
  parseSkillsCatalog,
  rebuildSkillsCatalog,
  resetSkillsSessionState,
  type ParsedSkill,
} from "../src/skill-discovery.js";

// ─── catalog helpers ─────────────────────────────────────────────────────

interface Skill { name: string; description: string; location: string }

function catalogEntry(s: Skill): string {
  return `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.location}</location>\n  </skill>\n`;
}

function systemPrompt(skills: Skill[]): string {
  const body = skills.map(catalogEntry).join("");
  return (
    "Intro paragraph for the agent.\n\n" +
    "The following skills provide specialized instructions.\n\n" +
    "<available_skills>\n" +
    body +
    "</available_skills>\n\nAfter the catalog, the prompt continues."
  );
}

function makeSkills(n: number): Skill[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `skill-${String(i).padStart(2, "0")}`,
    description: `Handles task number ${i}`,
    location: `/skills/skill-${i}/SKILL.md`,
  }));
}

/** Noul answers by original index; missing indices default to 0. */
function answersFor(scores: Record<number, number>): { answers: Record<string, { noul: number }> } {
  const answers: Record<string, { noul: number }> = {};
  for (const [idx, noul] of Object.entries(scores)) {
    answers[`s${idx}`] = { noul };
  }
  return { answers };
}

// ─── pure helpers ────────────────────────────────────────────────────────

describe("catalog parse/rebuild", () => {
  const skills = makeSkills(6);
  const prompt = systemPrompt(skills);

  it("parses all entries with fields intact", () => {
    const parsed = parseSkillsCatalog(prompt);
    assert.ok(parsed);
    assert.equal(parsed.entries.length, 6);
    assert.equal(parsed.entries[0]!.name, "skill-00");
    assert.equal(parsed.entries[5]!.description, "Handles task number 5");
    assert.equal(parsed.entries[2]!.location, "/skills/skill-2/SKILL.md");
  });

  it("rebuild keeps original order and appends the hidden-count line", () => {
    const parsed = parseSkillsCatalog(prompt)!;
    const kept = [parsed.entries[4]!, parsed.entries[1]!]; // picked out of order
    const rebuilt = rebuildSkillsCatalog(prompt, kept, 4);
    assert.ok(rebuilt.includes("<available_skills>"));
    assert.ok(rebuilt.includes("skill-04"));
    assert.ok(rebuilt.includes("skill-01"));
    assert.ok(!rebuilt.includes("skill-02"));
    assert.ok(rebuilt.indexOf("skill-04") < rebuilt.indexOf("skill-01"), "kept skills stay in catalog order");
    assert.ok(
      rebuilt.includes("4 other skills are installed but hidden for this session; any can still be loaded by reading its SKILL.md or via /skill:name."),
      "hidden-count line present",
    );
    assert.ok(rebuilt.includes("After the catalog, the prompt continues."), "rest of the prompt preserved");
  });

  it("zero kept still renders the section with the hidden-count line", () => {
    const parsed = parseSkillsCatalog(prompt)!;
    const rebuilt = rebuildSkillsCatalog(prompt, [], parsed.entries.length);
    assert.ok(rebuilt.includes("<available_skills>\n</available_skills>"));
    assert.ok(rebuilt.includes("6 other skills are installed but hidden"));
  });
});

describe("applyJudgement", () => {
  const entries: ParsedSkill[] = makeSkills(6).map((s) => ({
    name: s.name, description: s.description, location: s.location,
    raw: catalogEntry(s),
  }));

  it("threshold + cap + sort by score descending", () => {
    const answers = answersFor({ 0: 0.9, 1: 0.4, 2: 0.95, 3: 0.1, 4: 0.7, 5: 0.2 }).answers;
    const { kept, hidden } = applyJudgement(entries, answers, 0.3, 3);
    assert.deepEqual(
      kept.map((e) => e.name),
      ["skill-02", "skill-00", "skill-04"],
      "sorted by noul desc, capped at 3",
    );
    assert.deepEqual(
      hidden.map((e) => e.name),
      ["skill-01", "skill-03", "skill-05"],
      "rest are hidden (original catalog order)",
    );
  });

  it("missing noul scores count as 0 (excluded)", () => {
    const answers = answersFor({ 2: 0.9 }).answers;
    const { kept } = applyJudgement(entries, answers, 0.3, 6);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.name, "skill-02");
  });
});

// ─── hook end-to-end with a fake pi ─────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

describe("registerSkillJudging hook", () => {
  let home: string;
  let origHome: string | undefined;
  let fetchCalls: Array<{ url: string; body: { state?: string; model?: string; questions?: Record<string, unknown> } }>;
  let fetchQueue: Array<() => Response>;
  let realFetch: typeof globalThis.fetch;
  let statusCalls: Array<[string, string]>;
  let handlers: Record<string, Handler>;
  let appended: Array<{ customType: string; data?: unknown }>;
  let sessionEntries: Array<{ customType: string; data?: unknown }>;
  let sessionId: string;
  let registerSkillJudgingFn: (pi: unknown) => void;

  const skills = makeSkills(15);
  const fullPrompt = systemPrompt(skills);

  function fakePi(): unknown {
    handlers = {};
    appended = [];
    return {
      on: (event: string, handler: Handler) => { handlers[event] = handler; },
      appendEntry: (customType: string, data?: unknown) => { appended.push({ customType, data }); },
    };
  }

  function fakeCtx(): unknown {
    return {
      hasUI: true,
      ui: { setStatus: (key: string, value: string) => statusCalls.push([key, value]) },
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => sessionEntries,
      },
    };
  }

  async function turn(promptText: string): Promise<Record<string, unknown> | undefined> {
    return handlers["before_agent_start"]!(
      { type: "before_agent_start", prompt: promptText, systemPrompt: fullPrompt },
      fakeCtx(),
    );
  }

  function stubResponse(body: unknown): void {
    fetchQueue.push(() => new Response(JSON.stringify(body), { status: 200 }));
  }

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "skill-judge-"));
    origHome = process.env.HOME;
    process.env.HOME = home;
    sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    resetSkillsSessionState(sessionId);
    fetchCalls = [];
    fetchQueue = [];
    statusCalls = [];
    appended = [];
    sessionEntries = [];
    realFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (url: unknown, init: { body: string }) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const next = fetchQueue.shift();
      if (!next) throw new Error("no scripted fetch response");
      return next();
    };
    // utility namespace (engine reads) — registered by importing settings.js
    await import("../src/settings.js");
    // long-horizon namespace (judge settings the skill judge shares)
    await import("@pi-unipi/long-horizon/src/settings.js");
    const { setSettings } = await import("@pi-unipi/core");
    setSettings("long-horizon", {
      judge: { provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "test-key", baseUrl: "", timeoutMs: 200 },
    }, "global", process.cwd());
    const mod = await import("../src/skill-discovery.js");
    registerSkillJudgingFn = mod.registerSkillJudging;
    registerSkillJudgingFn(fakePi());
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("count ≤ maxSkills → no jev call, prompt untouched", async () => {
    const small = systemPrompt(makeSkills(5));
    const h = handlers["before_agent_start"]!;
    const r = await h({ type: "before_agent_start", prompt: "hello world", systemPrompt: small }, fakeCtx());
    assert.equal(fetchCalls.length, 0, "no fetch for a small catalog");
    assert.equal(r?.systemPrompt, undefined, "prompt returned unchanged (no override)");
  });

  it("first prompt over a large catalog: one jev call, frozen rebuild with hidden line", async () => {
    stubResponse(answersFor({ 0: 0.9, 5: 0.8, 9: 0.6 }));
    const result = await turn("fix a css flexbox bug in my page");
    assert.equal(fetchCalls.length, 1, "exactly one jev call");
    assert.equal(fetchCalls[0]!.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(fetchCalls[0]!.body.model, "typesafe/jev-1.13");
    assert.ok(fetchCalls[0]!.body.state.includes("fix a css flexbox bug"), "state carries the prompt");
    assert.equal(Object.keys(fetchCalls[0]!.body.questions ?? {}).length, 15, "one question per skill");
    const rebuilt = result?.systemPrompt as string;
    assert.ok(rebuilt.includes("skill-00") && rebuilt.includes("skill-05") && rebuilt.includes("skill-09"));
    assert.ok(!rebuilt.includes("skill-01"), "below-threshold skills hidden");
    assert.ok(rebuilt.includes("12 other skills are installed but hidden for this session"), "hidden-count line");
    assert.ok(statusCalls.some(([, v]) => v === "skills: 3/15 exposed"), "status line");
  });

  it("turns 2 and 3 are byte-identical to turn 1, including after a simulated reload", async () => {
    stubResponse(answersFor({ 0: 0.9, 5: 0.8, 9: 0.6 }));
    const turn1 = await turn("fix a css flexbox bug in my page");
    const frozen = turn1?.systemPrompt as string;
    assert.ok(frozen.includes("12 other skills are installed but hidden"));

    const turn2 = await turn("now write a haiku about it");
    assert.equal(turn2?.systemPrompt, frozen, "byte-identical on turn 2");

    // Simulate a reload: session entries replayed into a fresh hook state.
    for (const entry of appended) sessionEntries.push({ customType: entry.customType, data: entry.data });
    registerSkillJudgingFn(fakePi());
    const turn3 = await turn("another unrelated task");
    assert.equal(turn3?.systemPrompt, frozen, "byte-identical on turn 3 after restore");
    assert.ok(fetchCalls.length >= 1, "jev froze the set without extra calls after restore");
  });

  it("fail-open: unparseable jev answer exposes every skill", async () => {
    fetchQueue.push(() => new Response("teapot", { status: 418 }));
    const result = await turn("anything at all");
    assert.equal(result?.systemPrompt, fullPrompt, "all skills exposed, no hidden line");
    assert.ok(!JSON.stringify(result).includes("hidden for this session"));
  });

  it("fail-open: missing judge key exposes every skill without a fetch", async () => {
    const { setSettings } = await import("@pi-unipi/core");
    setSettings("long-horizon", { judge: { apiKey: "" } }, "global", process.cwd());
    const result = await turn("anything at all");
    assert.equal(fetchCalls.length, 0, "no network without a key");
    assert.equal(result?.systemPrompt, fullPrompt, "all skills exposed");
  });

  it("recheck reveals hidden skills once via a persisted message; system prompt unchanged", async () => {
    stubResponse(answersFor({ 0: 0.9, 5: 0.8, 9: 0.6 })); // freeze: skill-00/05/09 kept
    const turn1 = await turn("fix a css flexbox bug in my page");
    const frozen = turn1?.systemPrompt as string;
    assert.ok(frozen.includes("12 other skills are installed but hidden"));

    // turn 2 on a different topic: jev says two hidden skills are relevant
    stubResponse(answersFor({ 0: 0.9, 1: 0.8 }));
    const turn2 = await turn("make a pptx deck for the quarterly review");
    assert.equal(turn2?.systemPrompt, frozen, "system prompt is the SAME frozen prompt (recheck adds only a message)");
    const message = turn2?.message as { customType: string; content: string; display: boolean };
    assert.equal(message.customType, "unipi-skills-revealed");
    assert.ok(message.display, "display true");
    assert.ok(message.content.includes("Newly relevant skills for this request:"));
    assert.ok(message.content.includes("skill-01"), "first hidden reveal named");
    assert.ok(message.content.includes("skill-02"), "second hidden reveal named");
    assert.ok(message.content.includes("Read a skill's SKILL.md before using it."));
    assert.ok(appended.some((e) => e.customType === "unipi:skills-revealed"), "revealed persisted");

    // turn 3: same topic — the revealed skills are removed from hidden, so
    // they can never be announced again.
    fetchQueue.push(() => new Response(JSON.stringify({ answers: {} }), { status: 200 }));
    const turn3 = await turn("make a pptx deck for the quarterly review");
    assert.ok(turn3?.message === undefined, "no repeat announcement");
    assert.equal(turn3?.systemPrompt, frozen);
  });
});
