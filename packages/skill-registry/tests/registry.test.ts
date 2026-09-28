/**
 * @pi-unipi/skill-registry — judging, registry and settings tests (no network)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSettingsPath } from "@pi-unipi/core";
import {
  applyJudgement,
  decideTurn,
  emptyState,
  hiddenIndex,
  pinnedSkills,
  restoreState,
  SKILLS_JUDGED_ENTRY,
  type Entry,
} from "../src/judge.ts";
import { applyRegistry, effectiveState, skillCommandName } from "../src/registry.ts";
import { DEFAULT_EXPOSURE, migrateUtilitySkills, normalizeExposure, normalizeStates, registerSkillsSettings } from "../src/settings.ts";
import { getSettingsDefinition, getSettings } from "@pi-unipi/core";
import { listVaultSkills, parseFrontmatter } from "../src/vault.ts";

const WF = "/repo/packages/skill-registry/skills";
const e = (name: string, location = `/home/u/.agents/skills/${name}`, description = `${name} skill`): Entry => ({ name, description, location });

const CATALOG: Entry[] = [
  e("coffee-sandbox"), e("unipi-v3-development"), e("agent-browser"), e("browser-automation"),
  e("mempalace"), e("mempalace-recall"), e("mempalace-task"), e("grill-me"),
  e("work", `${WF}/work`), e("plan", `${WF}/plan`), e("research", `${WF}/research`), e("gather-context", `${WF}/gather-context`),
  e("quick-work", `${WF}/quick-work`), e("brainstorm", `${WF}/brainstorm`), e("debug", `${WF}/debug`),
];

describe("pins", () => {
  it("pins a skill from a distinctive name word — the 'ssh into coffee' miss", () => {
    assert.deepEqual([...pinnedSkills(CATALOG, "ssh into coffee and run pi there")], ["coffee-sandbox"]);
  });
  it("pins the full name, spaced or hyphenated, and /skill:name", () => {
    assert.ok(pinnedSkills(CATALOG, "use agent-browser to open example.com").has("agent-browser"));
    assert.ok(pinnedSkills(CATALOG, "grill me about this design").has("grill-me"));
    assert.ok(pinnedSkills(CATALOG, "/skill:plan the migration").has("plan"));
  });
  it("does not pin on common words or on tokens shared by many skills", () => {
    const pins = pinnedSkills(CATALOG, "please work on the plan and review the browser code");
    assert.equal(pins.has("work"), false);
    assert.equal(pins.has("plan"), false);
    assert.equal(pins.has("agent-browser"), false); // "browser" is in two names
    assert.equal(pinnedSkills(CATALOG, "search mempalace").has("mempalace"), true);
    assert.equal(pinnedSkills(CATALOG, "search mempalace").has("mempalace-task"), false); // 'mempalace' is in 3 names
  });
});

describe("applyJudgement", () => {
  const score = (m: Record<string, number>) =>
    Object.fromEntries(CATALOG.map((c, i) => [`s${i}`, { noul: m[c.name] ?? 0 }]));

  it("keeps pins even when jev scores them low", () => {
    const { kept } = applyJudgement(CATALOG, score({ work: 0.9 }), { threshold: 0.3, maxSkills: 12 }, new Set(["coffee-sandbox"]));
    assert.deepEqual(kept.map((k) => k.name), ["coffee-sandbox", "work"]);
  });

  it("caps generic workflow skills at 4 so they cannot crowd the list", () => {
    const high = Object.fromEntries(CATALOG.map((c) => [c.name, c.location.startsWith(WF) ? 0.9 : 0.5]));
    const { kept } = applyJudgement(CATALOG, score(high), { threshold: 0.3, maxSkills: 12 });
    const generic = kept.filter((k) => k.location.startsWith(WF));
    assert.equal(generic.length, 4);
    assert.ok(kept.some((k) => k.name === "coffee-sandbox"));
  });

  it("respects threshold and the total cap", () => {
    const { kept, hidden } = applyJudgement(CATALOG, score({ "agent-browser": 0.95, "browser-automation": 0.8, mempalace: 0.2 }), { threshold: 0.3, maxSkills: 1 });
    assert.deepEqual(kept.map((k) => k.name), ["agent-browser"]);
    assert.equal(hidden.length, CATALOG.length - 1);
  });
});

describe("hidden index", () => {
  it("names every hidden skill grouped by folder", () => {
    const text = hiddenIndex([e("coffee-sandbox", "/x/skills/coffee-sandbox"), e("plan", `${WF}/plan`), e("odd", "/y/other-dir")]);
    assert.match(text, /- \/x\/skills\/: coffee-sandbox/);
    assert.match(text, /packages\/skill-registry\/skills\/: plan/);
    assert.match(text, /odd \(\/y\/other-dir\/SKILL\.md\)/);
    assert.equal(hiddenIndex([]), "");
  });
});

describe("decideTurn", () => {
  const settings = { ...DEFAULT_EXPOSURE, maxSkills: 5 };
  const ask = (scores: Record<string, number>) => async (req: { questions: Record<string, unknown> }) =>
    Object.fromEntries(Object.entries(req.questions).map(([k, q]) => {
      const name = String((q as { instructions: string }).instructions).match(/skill "([^"]+)"/)![1]!;
      return [k, { noul: scores[name] ?? 0 }];
    }));

  it("does not judge or freeze on a greeting", async () => {
    const state = emptyState("s");
    let calls = 0;
    const out = await decideTurn({ prompt: "hi there", catalog: CATALOG, settings, cwd: "/r", state, ask: async () => { calls++; return null; } });
    assert.equal(calls, 0);
    assert.equal(state.judged, false);
    assert.equal(out.listed.size, CATALOG.length);
  });

  it("freezes on the first real prompt with pins, jev picks and a hidden index", async () => {
    const state = emptyState("s");
    const out = await decideTurn({ prompt: "ssh into coffee and check the browser", catalog: CATALOG, settings, cwd: "/r", state, ask: ask({ "browser-automation": 0.8 }) });
    assert.deepEqual([...out.listed].sort(), ["browser-automation", "coffee-sandbox"]);
    assert.ok(out.freeze);
    assert.match(out.index, /mempalace/);
    assert.equal(state.judged, true);
  });

  it("frozen turns keep the same list and index, and announce a pinned hidden skill once", async () => {
    const state = emptyState("s");
    const first = await decideTurn({ prompt: "fix the browser tests", catalog: CATALOG, settings, cwd: "/r", state, ask: ask({ "browser-automation": 0.9 }) });
    const second = await decideTurn({ prompt: "now search mempalace for the decision", catalog: CATALOG, settings: { ...settings, recheck: false }, cwd: "/r", state, ask: async () => null });
    assert.deepEqual([...second.listed], [...first.listed]);
    assert.equal(second.index, first.index);
    assert.deepEqual(second.reveal.map((r) => r.name), ["mempalace"]);
    const third = await decideTurn({ prompt: "search mempalace again", catalog: CATALOG, settings: { ...settings, recheck: false }, cwd: "/r", state, ask: async () => null });
    assert.equal(third.reveal.length, 0);
  });

  it("fails open when jev is unavailable", async () => {
    const out = await decideTurn({ prompt: "refactor the kanboard daemon", catalog: CATALOG, settings, cwd: "/r", state: emptyState("s"), ask: async () => null });
    assert.equal(out.listed.size, CATALOG.length);
    assert.equal(out.freeze?.failOpen, true);
  });

  it("restores the frozen set and index from session entries", () => {
    const state = restoreState("s", [{ customType: SKILLS_JUDGED_ENTRY, data: { kept: ["plan"], hidden: [e("mempalace")], index: "IDX" } }]);
    assert.equal(state.judged, true);
    assert.deepEqual(state.kept, ["plan"]);
    assert.equal(state.index, "IDX");
  });
});

describe("registry", () => {
  const vault = "/home/u/.unipi/skill-vault";
  const cat = [
    { name: "vaulted", description: "v", baseDir: `${vault}/vaulted` },
    { name: "global-one", description: "g", baseDir: "/home/u/.agents/skills/global-one" },
    { name: "quiet", description: "q", baseDir: "/home/u/.agents/skills/quiet" },
  ];

  it("keeps vault skills off by default and applies explicit states", () => {
    const r = applyRegistry(cat, { quiet: "unlisted" }, "/repo", vault);
    assert.deepEqual(r.listed.map((s) => s.name), ["global-one"]);
    assert.deepEqual([...r.disabled], ["vaulted"]);
    assert.deepEqual(r.unlisted.map((s) => s.name), ["quiet"]);
    const on = applyRegistry(cat, { vaulted: "on", "global-one": "off" }, "/repo", vault);
    assert.deepEqual(on.listed.map((s) => s.name).sort(), ["quiet", "vaulted"]);
    assert.deepEqual([...on.disabled], ["global-one"]);
  });

  it("resolves defaults per source", () => {
    assert.deepEqual(effectiveState(undefined, "vault"), { enabled: false, discoverable: false });
    assert.deepEqual(effectiveState("unlisted", "user"), { enabled: true, discoverable: false });
    assert.deepEqual(effectiveState(undefined, "user"), { enabled: true, discoverable: true });
  });

  it("parses /skill:name commands", () => {
    assert.equal(skillCommandName("/skill:coffee-sandbox do it"), "coffee-sandbox");
    assert.equal(skillCommandName("hello"), undefined);
  });

});

describe("settings", () => {
  it("moves utility.skills into skills.exposure (project layer)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "unipi-skills-mig-"));
    const util = projectSettingsPath(cwd, "utility");
    mkdirSync(join(util, ".."), { recursive: true });
    writeFileSync(util, JSON.stringify({ rename: { auto: false }, skills: { mode: "off", maxSkills: 8 } }));
    migrateUtilitySkills(cwd);
    assert.deepEqual(JSON.parse(readFileSync(util, "utf8")), { rename: { auto: false } });
    assert.deepEqual(JSON.parse(readFileSync(projectSettingsPath(cwd, "skills"), "utf8")).exposure, { mode: "off", maxSkills: 8 });
  });

  it("lists every skill as a hub row grouped by source, vault defaulting to off", () => {
    const cwd = mkdtempSync(join(tmpdir(), "unipi-skills-rows-"));
    registerSkillsSettings([
      { name: "aws-deploy", description: "Deploy to AWS", baseDir: "/v/aws-deploy" },
      { name: "grill-me", description: "Grill the design", baseDir: "/home/u/.agents/skills/grill-me" },
      { name: "local-one", description: "Project skill", baseDir: `${cwd}/.agents/skills/local-one` },
    ], cwd, "/v");
    const def = getSettingsDefinition("skills")!;
    const titles = def.schema!.map((sec) => sec.title);
    assert.ok(titles.includes("Project skills") && titles.includes("Vault (off until turned on)") && titles.includes("Package skills"));
    const row = def.schema!.flatMap((sec) => sec.fields).find((f) => f.key === "states.aws-deploy");
    assert.equal(row?.type, "enum");
    const states = (getSettings("skills", cwd) as { states: Record<string, string> }).states;
    assert.equal(states["aws-deploy"], "off");
    assert.equal(states["local-one"], "on");
    registerSkillsSettings();
  });

  it("reads the earlier { enabled, discoverable } shape", () => {
    assert.deepEqual(normalizeStates({ a: { enabled: false }, b: { discoverable: false }, c: "unlisted", d: { enabled: true }, e: 3 }), { a: "off", b: "unlisted", c: "unlisted", d: "on" });
  });

  it("normalizes exposure values", () => {
    assert.deepEqual(normalizeExposure({ mode: "bogus", threshold: 2 }), DEFAULT_EXPOSURE);
  });
});

describe("vault", () => {
  it("lists vault skills from nested folders with block descriptions", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-vault-"));
    mkdirSync(join(dir, "pack", "deploy-aws"), { recursive: true });
    writeFileSync(join(dir, "pack", "deploy-aws", "SKILL.md"), "---\nname: deploy-aws\ndescription: >-\n  Deploy to AWS.\n  Use for releases.\n---\n# x\n");
    mkdirSync(join(dir, "no-desc"));
    writeFileSync(join(dir, "no-desc", "SKILL.md"), "---\nname: no-desc\n---\n");
    assert.deepEqual(listVaultSkills(dir).map((s) => [s.name, s.description]), [["deploy-aws", "Deploy to AWS. Use for releases."]]);
    assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: \"quoted\"\n---"), { name: "a", description: "quoted" });
  });
});
