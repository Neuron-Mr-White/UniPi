/**
 * @pi-unipi/utility — Skill discovery gate tests
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origAgentDir: string | undefined;

interface CatalogSkill {
  name: string;
  description: string;
  location: string;
}

function skillsSection(skills: CatalogSkill[]): string {
  const lines = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const s of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${s.name}</name>`);
    lines.push(`    <description>${s.description}</description>`);
    lines.push(`    <location>${s.location}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

const UNIPI_INSTALLED: CatalogSkill = {
  name: "workflow-work",
  description: "Execute plan",
  location: "/home/u/.pi/agent/npm/node_modules/@pi-unipi/workflow/skills/work/SKILL.md",
};
const UNIPI_DEV: CatalogSkill = {
  name: "memory",
  description: "Persistent memory management",
  location: "/home/u/Projects/archived/unipi/packages/memory/skills/memory/SKILL.md",
};
const USER_GLOBAL: CatalogSkill = {
  name: "brave-search",
  description: "Web search via Brave",
  location: "/home/u/.pi/agent/skills/brave-search/SKILL.md",
};
const USER_PROJECT: CatalogSkill = {
  name: "deploy",
  description: "Deploy the service",
  location: "/srv/app/.agents/skills/deploy/SKILL.md",
};

function buildBasePrompt(): string {
  return [
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "",
    "Available tools:",
    "- read: Read file contents",
  ].join("\n");
}

function buildPrompt(skills: CatalogSkill[]): string {
  return buildBasePrompt() + skillsSection(skills) + "\nCurrent working directory: /tmp/proj";
}

describe("stripBundledSkills", () => {
  it("removes bundled skills but keeps user skills cataloged", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const prompt = buildPrompt([UNIPI_INSTALLED, USER_GLOBAL, USER_PROJECT]);

    const filtered = stripBundledSkills(prompt);
    assert.ok(filtered);
    // User skills survive with full catalog structure.
    assert.ok(filtered.includes("<available_skills>"));
    assert.ok(filtered.includes("<name>brave-search</name>"));
    assert.ok(filtered.includes("<name>deploy</name>"));
    // Bundled skills are gone.
    assert.ok(!filtered.includes("workflow-work"));
    assert.ok(!filtered.includes("@pi-unipi"));
    // Intro paragraph and section tags remain for the kept skills.
    assert.ok(filtered.includes("The following skills provide specialized instructions"));
    // Prompt head/tail intact.
    assert.ok(filtered.startsWith("You are an expert coding assistant"));
    assert.ok(filtered.endsWith("Current working directory: /tmp/proj"));
  });

  it("matches bundled skills in dev-checkout locations", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const prompt = buildPrompt([UNIPI_DEV, USER_GLOBAL]);

    const filtered = stripBundledSkills(prompt);
    assert.ok(filtered);
    assert.ok(!filtered.includes("archived/unipi/packages"));
    assert.ok(filtered.includes("<name>brave-search</name>"));
    assert.ok(filtered.includes("<available_skills>"));
  });

  it("removes the entire section when only bundled skills exist", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const prompt = buildPrompt([UNIPI_INSTALLED, UNIPI_DEV]);

    const filtered = stripBundledSkills(prompt);
    assert.ok(filtered);
    assert.ok(!filtered.includes("<available_skills>"));
    assert.ok(!filtered.includes("specialized instructions"));
    assert.ok(!filtered.includes("\n\n\n"));
    assert.ok(filtered.startsWith("You are an expert coding assistant"));
    assert.ok(filtered.endsWith("Current working directory: /tmp/proj"));
  });

  it("returns undefined when no bundled skills are present (no-op)", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const prompt = buildPrompt([USER_GLOBAL, USER_PROJECT]);
    assert.equal(stripBundledSkills(prompt), undefined);
  });

  it("returns undefined when there is no skills section", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const prompt = buildBasePrompt() + "\nCurrent working directory: /tmp/proj";
    assert.equal(stripBundledSkills(prompt), undefined);
  });

  it("does not treat user paths containing 'unipi' text as bundled", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const tricky: CatalogSkill = {
      name: "my-unipi-notes",
      description: "User skill that merely mentions unipi",
      location: "/home/u/skills/my-unipi-notes/SKILL.md",
    };
    const prompt = buildPrompt([tricky]);
    // /unipi/packages/ does not appear — entry must be kept.
    assert.equal(stripBundledSkills(prompt), undefined);
  });

  it("handles a mixed catalog where the bundled entry is last", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const prompt = buildPrompt([USER_GLOBAL, USER_PROJECT, UNIPI_INSTALLED]);

    const filtered = stripBundledSkills(prompt);
    assert.ok(filtered);
    assert.ok(filtered.includes("<name>deploy</name>"));
    assert.ok(filtered.includes("</available_skills>"));
  });

  it("is idempotent (already-filtered prompt → undefined)", async () => {
    const { stripBundledSkills } = await import("../src/skill-discovery.js");
    const once = stripBundledSkills(buildPrompt([UNIPI_INSTALLED, USER_GLOBAL]));
    assert.ok(once);
    const twice = stripBundledSkills(once);
    assert.equal(twice, undefined);
  });
});

describe("isBundledSkillLocation", () => {
  it("classifies npm-installed and dev-checkout paths as bundled", async () => {
    const { isBundledSkillLocation } = await import("../src/skill-discovery.js");
    assert.ok(isBundledSkillLocation(UNIPI_INSTALLED.location));
    assert.ok(isBundledSkillLocation(UNIPI_DEV.location));
    assert.ok(!isBundledSkillLocation(USER_GLOBAL.location));
    assert.ok(!isBundledSkillLocation(USER_PROJECT.location));
  });
});

describe("skill discovery settings", () => {
  beforeEach(() => {
    origAgentDir = process.env.PI_AGENT_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-skills-test-"));
    fs.mkdirSync(path.join(tmpDir, "settings"), { recursive: true });
    process.env.PI_AGENT_DIR = path.join(tmpDir, "settings");
  });

  afterEach(() => {
    if (origAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = origAgentDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to discovery on when settings file is missing", async () => {
    const { loadSkillDiscoverySettings } = await import("../src/skill-discovery.js");
    assert.equal(loadSkillDiscoverySettings().discovery, true);
  });

  it("defaults to discovery on when the unipi.skills key is absent", async () => {
    const { loadSkillDiscoverySettings } = await import("../src/skill-discovery.js");
    fs.writeFileSync(
      path.join(tmpDir, "settings", "settings.json"),
      JSON.stringify({ theme: "dark", unipi: { footer: { enabled: true } } }),
    );
    assert.equal(loadSkillDiscoverySettings().discovery, true);
  });

  it("round-trips off and preserves sibling unipi keys", async () => {
    const { loadSkillDiscoverySettings, saveSkillDiscoverySettings } = await import("../src/skill-discovery.js");
    const settingsPath = path.join(tmpDir, "settings", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", unipi: { footer: { enabled: true } } }),
    );

    assert.equal(saveSkillDiscoverySettings({ discovery: false }), true);
    assert.equal(loadSkillDiscoverySettings().discovery, false);

    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    assert.equal(raw.theme, "dark");
    assert.deepEqual(raw.unipi.footer, { enabled: true });
    assert.deepEqual(raw.unipi.skills, { discovery: false });

    assert.equal(saveSkillDiscoverySettings({ discovery: true }), true);
    assert.equal(loadSkillDiscoverySettings().discovery, true);
  });

  it("ignores malformed settings files", async () => {
    const { loadSkillDiscoverySettings } = await import("../src/skill-discovery.js");
    fs.writeFileSync(path.join(tmpDir, "settings", "settings.json"), "{not json");
    assert.equal(loadSkillDiscoverySettings().discovery, true);
  });
});
