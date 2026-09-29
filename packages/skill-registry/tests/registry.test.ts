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
import { DEFAULT_EXPOSURE, migrateUtilitySkills, normalizeExposure, normalizeStates, readStateLayers, writeStateLayers } from "../src/settings.ts";
import { SkillEditor, cellValue, type EditorResult } from "../src/editor.ts";
import { listVaultSkills, parseFrontmatter } from "../src/vault.ts";

const e = (name: string, location = `/home/u/.agents/skills/${name}`, description = `${name} skill`): Entry => ({ name, description, location });

const CATALOG: Entry[] = [
  e("coffee-sandbox"), e("unipi-v3-development"), e("agent-browser"), e("browser-automation"),
  e("mempalace"), e("mempalace-recall"), e("mempalace-task"), e("grill-me"),
  e("work"), e("plan"), e("research"), e("gather-context"),
  e("quick-work"), e("brainstorm"), e("debug"),
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

  it("ignores pi's image placeholders when pinning; a plain mention still pins", () => {
    const withImage = [...CATALOG, e("image")];
    const placeholders = "[Image #1]\n\nLook at this. [Image #2] [Image #3] [Image #4] [Image #5] [Image #6] [Image #7]";
    assert.equal(pinnedSkills(withImage, placeholders).has("image"), false);
    assert.ok(pinnedSkills(withImage, "generate an image of a cup").has("image"));
  });
});

describe("applyJudgement", () => {
  const score = (m: Record<string, number>) =>
    Object.fromEntries(CATALOG.map((c, i) => [`s${i}`, { noul: m[c.name] ?? 0 }]));

  it("keeps pins even when jev scores them low", () => {
    const { kept } = applyJudgement(CATALOG, score({ work: 0.9 }), { threshold: 0.3, maxSkills: 12 }, new Set(["coffee-sandbox"]));
    assert.deepEqual(kept.map((k) => k.name), ["coffee-sandbox", "work"]);
  });

  it("respects threshold and the total cap", () => {
    const { kept, hidden } = applyJudgement(CATALOG, score({ "agent-browser": 0.95, "browser-automation": 0.8, mempalace: 0.2 }), { threshold: 0.3, maxSkills: 1 });
    assert.deepEqual(kept.map((k) => k.name), ["agent-browser"]);
    assert.equal(hidden.length, CATALOG.length - 1);
  });
});

describe("hidden index", () => {
  it("names every hidden skill grouped by folder", () => {
    const text = hiddenIndex([e("coffee-sandbox", "/x/skills/coffee-sandbox"), e("plan", "/x/skills/plan"), e("odd", "/y/other-dir")]);
    assert.match(text, /- \/x\/skills\/: coffee-sandbox, plan/);
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
    const r = applyRegistry(cat, { quiet: { enabled: false } }, "/repo", vault);
    assert.deepEqual(r.listed.map((s) => s.name), ["global-one"]);
    assert.deepEqual([...r.disabled].sort(), ["quiet", "vaulted"]);
    const on = applyRegistry(cat, { vaulted: { enabled: true, mustShow: true }, "global-one": { enabled: false }, quiet: { enabled: false, mustShow: true } }, "/repo", vault);
    assert.deepEqual(on.listed.map((s) => s.name).sort(), ["quiet", "vaulted"]);
    assert.deepEqual([...on.disabled], ["global-one"]);
    assert.deepEqual([...on.mustShow].sort(), ["quiet", "vaulted"], "must show wins over disabled");
  });

  it("resolves defaults per source", () => {
    assert.deepEqual(effectiveState(undefined, "vault"), { enabled: false, mustShow: false });
    assert.deepEqual(effectiveState({ enabled: false }, "user"), { enabled: false, mustShow: false });
    assert.deepEqual(effectiveState(undefined, "user"), { enabled: true, mustShow: false });
    assert.deepEqual(effectiveState({ mustShow: true }, "vault"), { enabled: true, mustShow: true }, "must show implies enabled");
  });

  it("parses /skill:name commands", () => {
    assert.equal(skillCommandName("/skill:coffee-sandbox do it"), "coffee-sandbox");
    assert.equal(skillCommandName("hello"), undefined);
  });

});

describe("legacy state migration", () => {
  const vault = "/home/u/.unipi/skill-vault";
  const skill = (name: string) => ({ name, description: "d", baseDir: `/home/u/.agents/skills/${name}` });

  it("{discoverable:false} → disabled", () => {
    const states = normalizeStates({ quiet: { discoverable: false } });
    assert.deepEqual(states, { quiet: { enabled: false } });
    const r = applyRegistry([skill("quiet")], states, "/repo", vault);
    assert.deepEqual([...r.disabled], ["quiet"]);
    assert.deepEqual(r.listed, []);
  });

  it("\"unlisted\" → disabled", () => {
    const states = normalizeStates({ quiet: "unlisted" });
    assert.deepEqual(states, { quiet: { enabled: false } });
    const r = applyRegistry([skill("quiet")], states, "/repo", vault);
    assert.deepEqual([...r.disabled], ["quiet"]);
  });

  it("{discoverable:false, mustShow:true} → enabled and listed", () => {
    const states = normalizeStates({ quiet: { discoverable: false, mustShow: true } });
    assert.deepEqual(states, { quiet: { mustShow: true } });
    const r = applyRegistry([skill("quiet")], states, "/repo", vault);
    assert.deepEqual(r.listed.map((s) => s.name), ["quiet"]);
    assert.deepEqual([...r.mustShow], ["quiet"]);
    assert.equal(r.disabled.size, 0);
  });

  it("a vault skill with no state → disabled", () => {
    const r = applyRegistry([{ name: "vaulted", description: "d", baseDir: `${vault}/vaulted` }], {}, "/repo", vault);
    assert.deepEqual([...r.disabled], ["vaulted"]);
    assert.deepEqual(r.listed, []);
    assert.equal(r.mustShow.size, 0);
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

  it("reads the short-lived string form (unlisted migrates to off)", () => {
    assert.deepEqual(normalizeStates({ a: "off", b: "unlisted", c: { mustShow: true, x: 1 }, e: 3 }), { a: { enabled: false }, b: { enabled: false }, c: { mustShow: true } });
  });

  it("saves only the cells that changed, unsetting cleared ones", () => {
    const cwd = mkdtempSync(join(tmpdir(), "unipi-skills-write-"));
    const before = { global: {}, project: { "sql-review": { enabled: false } } };
    const after = { global: { "aws-deploy": { enabled: true } }, project: { "sql-review": { mustShow: true } } };
    assert.equal(writeStateLayers(cwd, before, after), 3);
    assert.deepEqual(readStateLayers(cwd).project, { "sql-review": { mustShow: true } });
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

describe("must show", () => {
  it("keeps a pinned skill through judging and adds one pinned after the freeze", async () => {
    const catalog = Array.from({ length: 14 }, (_, i) => ({ name: `skill-${i}`, description: `does thing ${i}`, location: `/s/${i}` }));
    const low = async () => Object.fromEntries(catalog.map((_, i) => [`s${i}`, { noul: 0.05 }])) as never;
    const state = { judged: false, kept: [], hidden: [], index: "", revealed: new Set<string>() } as never;
    const first = await decideTurn({ prompt: "refactor the parser module please", catalog, settings: { ...DEFAULT_EXPOSURE }, cwd: "/r", state, mustShow: new Set(["skill-3"]), ask: low });
    assert.ok(first.listed.has("skill-3"));
    const later = await decideTurn({ prompt: "now fix the tests", catalog, settings: { ...DEFAULT_EXPOSURE, recheck: false }, cwd: "/r", state, mustShow: new Set(["skill-3", "skill-9"]), ask: low });
    assert.ok(later.listed.has("skill-9"));
  });
});

describe("skill settings overlay", () => {
  const skills = [
    { name: "aws-deploy", description: "Deploy to AWS", source: "vault" as const },
    { name: "sql-review", description: "Review SQL", source: "user" as const },
  ];
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const make = (layers = { global: {}, project: {} }) => {
    let result: EditorResult | undefined;
    const ed = new SkillEditor({ skills, layers, proxy: true, initialScope: "project", theme, onDone: (r) => (result = r), visibleRows: 10 });
    return { ed, get result() { return result; } };
  };

  it("shows effective values with a legend and moves between E and M with ←/→", () => {
    const h = make({ global: { "sql-review": { mustShow: true } }, project: {} });
    const text = h.ed.render(140).join("\n");
    assert.match(text, /E\s+M\s+skill/);
    assert.match(text, /\[ \] \[ \]\s+aws-deploy/, "vault skill is off by default");
    assert.match(text, /\[x\] \[x\]\s+sql-review/, "inherited global must show");
    assert.match(text, /E enabled/);
    assert.match(text, /M must show/);
    h.ed.handleInput("\x1b[C"); // → M (two columns: wraps from E)
    h.ed.handleInput("\x1b[D"); // ← wraps back to E
    h.ed.handleInput("\x1b[B"); // sql-review
    h.ed.handleInput(" "); // disable (project)
    h.ed.handleInput("\r");
    assert.equal(h.result?.type, "saved");
    assert.deepEqual(h.result?.layers.project, { "sql-review": { enabled: false } });
    assert.deepEqual(h.result?.layers.global, { "sql-review": { mustShow: true } });
  });

  it("d clears the edited layer's value; g switches scope; esc cancels", () => {
    const h = make({ global: {}, project: { "aws-deploy": { enabled: true } } });
    assert.equal(cellValue({ global: {}, project: { "aws-deploy": { enabled: true } } }, skills[0]!, "enabled").from, "project");
    h.ed.handleInput("d");
    h.ed.handleInput("g"); // now editing global
    h.ed.handleInput(" "); // aws-deploy enabled at global
    h.ed.handleInput("\r");
    assert.deepEqual(h.result?.layers, { global: { "aws-deploy": { enabled: true } }, project: {} });
    const c = make();
    c.ed.handleInput("\x1b");
    assert.equal(c.result?.type, "cancelled");
  });
});
