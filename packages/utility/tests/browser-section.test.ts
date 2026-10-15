/**
 * @pi-unipi/utility — the browser context section (UNI-300):
 * applyBrowserSection sets/removes sections["unipi-browser"] from the
 * host's browser.enabled state (this is the exact function before_agent_start
 * calls in src/index.ts). Also: registerSkillCondition wiring — the "browser"
 * condition tracks the same state.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSkillCondition, resetSkillConditionsForTests, skillConditionPasses } from "@pi-unipi/core";
import { applyBrowserSection, readBrowserEnabled, resetBrowserProfilesCache } from "../src/browser/state.ts";

describe("utility — browser section", () => {
  let hostDirPath: string;
  let origHostDir: string | undefined;

  beforeEach(() => {
    hostDirPath = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-host-"));
    origHostDir = process.env.UNIPI_HOST_DIR;
    process.env.UNIPI_HOST_DIR = hostDirPath;
    resetBrowserProfilesCache();
    resetSkillConditionsForTests();
  });

  afterEach(() => {
    resetSkillConditionsForTests();
    if (origHostDir === undefined) delete process.env.UNIPI_HOST_DIR;
    else process.env.UNIPI_HOST_DIR = origHostDir;
    fs.rmSync(hostDirPath, { recursive: true, force: true });
  });

  it("no config.json (dir exists) → on by default: section set", () => {
    const sections: Record<string, string> = {};
    applyBrowserSection(sections);
    assert.match(sections["unipi-browser"]!, /The PC's browser is on/);
    assert.match(sections["unipi-browser"]!, /skill:browser/);
    assert.match(sections["unipi-browser"]!, /Profiles: default/);
  });

  it("explicit enabled:false → section removed (and not re-added)", () => {
    fs.writeFileSync(path.join(hostDirPath, "config.json"), JSON.stringify({ browser: { enabled: false } }));
    const sections: Record<string, string> = { "unipi-browser": "stale text from a previous on turn" };
    applyBrowserSection(sections);
    assert.equal(sections["unipi-browser"], undefined);
  });

  it("explicit enabled:true → section set", () => {
    fs.writeFileSync(path.join(hostDirPath, "config.json"), JSON.stringify({ browser: { enabled: true } }));
    const sections: Record<string, string> = {};
    applyBrowserSection(sections);
    assert.match(sections["unipi-browser"]!, /The PC's browser is on/);
  });

  it("text only changes when the state changes — same state, byte-identical section", () => {
    const first: Record<string, string> = {};
    applyBrowserSection(first);
    const second: Record<string, string> = {};
    applyBrowserSection(second);
    assert.equal(first["unipi-browser"], second["unipi-browser"]);
  });

  it("registerSkillCondition('browser', readBrowserEnabled) tracks the same on/off state", () => {
    registerSkillCondition("browser", () => readBrowserEnabled());
    assert.equal(skillConditionPasses("browser"), true);
    fs.writeFileSync(path.join(hostDirPath, "config.json"), JSON.stringify({ browser: { enabled: false } }));
    assert.equal(skillConditionPasses("browser"), false);
  });
});
