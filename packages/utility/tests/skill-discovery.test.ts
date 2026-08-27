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

const SKILLS_SECTION = [
  "",
  "",
  "The following skills provide specialized instructions for specific tasks.",
  "Use the read tool to load a skill's file when the task matches its description.",
  "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
  "",
  "<available_skills>",
  "  <skill>",
  "    <name>workflow</name>",
  "    <description>Execute plan</description>",
  "    <location>/pkg/workflow/skills/work/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

function buildBasePrompt(): string {
  return [
    "You are an expert coding assistant operating inside pi, a coding agent harness.",
    "",
    "Available tools:",
    "- read: Read file contents",
    "",
    "Guidelines:",
    "- Be concise in your responses",
  ].join("\n");
}

describe("stripSkillsSection", () => {
  it("strips the skills section from a default system prompt", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt = buildBasePrompt() + SKILLS_SECTION + "\nCurrent working directory: /tmp/proj";

    const stripped = stripSkillsSection(prompt);
    assert.ok(stripped);
    assert.ok(!stripped.includes("<available_skills>"));
    assert.ok(!stripped.includes("specialized instructions"));
    assert.ok(!stripped.includes("<skill>"));
    // Prompt head and trailing cwd line survive intact.
    assert.ok(stripped.startsWith("You are an expert coding assistant"));
    assert.ok(stripped.endsWith("Current working directory: /tmp/proj"));
    // No triple newlines left behind.
    assert.ok(!stripped.includes("\n\n\n"));
  });

  it("strips when context files precede the skills section", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt =
      buildBasePrompt() +
      "\n\n<project_context>\n\n<project_instructions path=\"AGENTS.md\">\nBe nice.\n</project_instructions>\n\n</project_context>\n" +
      SKILLS_SECTION +
      "\nCurrent working directory: /tmp/proj";

    const stripped = stripSkillsSection(prompt);
    assert.ok(stripped);
    assert.ok(stripped.includes("</project_context>"));
    assert.ok(!stripped.includes("<available_skills>"));
    assert.ok(stripped.endsWith("Current working directory: /tmp/proj"));
    assert.ok(!stripped.includes("\n\n\n"));
  });

  it("strips when the intro wording differs (anchor-based)", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt =
      buildBasePrompt() +
      "\n\nTotally different intro sentence.\nSecond intro line.\n\n<available_skills>\n  <skill>\n    <name>x</name>\n    <description>y</description>\n    <location>z</location>\n  </skill>\n</available_skills>" +
      "\nCurrent working directory: /tmp/proj";

    const stripped = stripSkillsSection(prompt);
    assert.ok(stripped);
    assert.ok(!stripped.includes("<available_skills>"));
    assert.ok(!stripped.includes("Totally different intro"));
    assert.ok(stripped.endsWith("Current working directory: /tmp/proj"));
  });

  it("strips in a custom-prompt prompt (skills appended after custom text)", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt = "Custom system prompt body." + SKILLS_SECTION + "\nCurrent working directory: /tmp/proj";

    const stripped = stripSkillsSection(prompt);
    assert.ok(stripped);
    assert.ok(stripped.startsWith("Custom system prompt body."));
    assert.ok(!stripped.includes("<available_skills>"));
  });

  it("returns undefined when there is no skills section", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt = buildBasePrompt() + "\nCurrent working directory: /tmp/proj";
    assert.equal(stripSkillsSection(prompt), undefined);
  });

  it("is idempotent (already-stripped prompt → undefined)", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt = buildBasePrompt() + SKILLS_SECTION + "\nCurrent working directory: /tmp/proj";
    const once = stripSkillsSection(prompt);
    assert.ok(once);
    assert.equal(stripSkillsSection(once), undefined);
  });

  it("returns undefined on truncated section (no closing tag)", async () => {
    const { stripSkillsSection } = await import("../src/skill-discovery.js");
    const prompt = buildBasePrompt() + "\n\nintro\n\n<available_skills>\n  <skill>";
    assert.equal(stripSkillsSection(prompt), undefined);
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
