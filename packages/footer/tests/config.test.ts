/**
 * @pi-unipi/footer — Config tests
 *
 * New settings shape: defaults, legacy `mono` → `none`, old classic keys
 * ignored, and the load cache invalidated by saveFooterSettings.
 *
 * Writes go to a temp HOME (the engine resolves paths at call time), so the
 * real ~/.unipi is never touched. Each test file runs in its own process.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let realHome: string | undefined;
let tmpHome: string;

function configDir(): string {
  return path.join(tmpHome, ".unipi", "config", "footer");
}

function writeConfig(value: Record<string, unknown>): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(path.join(configDir(), "config.json"), JSON.stringify(value, null, 2));
}

beforeEach(() => {
  realHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-footer-test-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("footer settings defaults", () => {
  it("loads defaults when no config exists", async () => {
    const { loadFooterSettings, DEFAULT_FOOTER_SETTINGS } = await import("../src/config.ts");
    const s = loadFooterSettings();
    assert.deepEqual(s, DEFAULT_FOOTER_SETTINGS);
    assert.equal(s.enabled, true);
    assert.equal(s.rainbow, "always");
    assert.equal(s.processLine, true);
    for (const key of ["turns", "time", "speed", "tokens", "cost", "compactions", "cache"] as const) {
      assert.equal(s.strip[key], true, `strip.${key} defaults on`);
    }
    for (const key of ["mode", "planPermission", "fusion", "kanboard"] as const) {
      assert.equal(s.badges[key], true, `badges.${key} defaults on`);
    }
  });
});

describe("legacy settings", () => {
  it("legacy colorMode mono loads as none", async () => {
    const { loadFooterSettings } = await import("../src/config.ts");
    writeConfig({ colorMode: "mono" });
    // The cache may hold the defaults from an earlier load in this process —
    // a fresh mtime forces a reload.
    const { invalidateFooterSettingsCache } = await import("../src/config.ts");
    invalidateFooterSettingsCache();
    assert.equal(loadFooterSettings().colorMode, "none");
  });

  it("old classic keys (preset, separator, groups, glanceMode…) are ignored", async () => {
    const { loadFooterSettings, invalidateFooterSettingsCache } = await import("../src/config.ts");
    writeConfig({
      preset: "full",
      separator: "powerline",
      zoneSeparator: "╎",
      showFullLabels: true,
      glanceMode: false,
      groups: { core: { show: false, segments: {} } },
      colorMode: "256",
    });
    invalidateFooterSettingsCache();
    const s = loadFooterSettings();
    // No crash, colorMode still honored, everything else default.
    assert.equal(s.colorMode, "256");
    assert.equal(s.enabled, true);
    assert.equal(s.strip.tokens, true);
    assert.ok(!("preset" in s));
    assert.ok(!("groups" in s));
  });

  it("invalid values fall back to defaults", async () => {
    const { loadFooterSettings, invalidateFooterSettingsCache } = await import("../src/config.ts");
    writeConfig({ rainbow: "sometimes", iconStyle: "wingdings", strip: { tokens: "yes" } });
    invalidateFooterSettingsCache();
    const s = loadFooterSettings();
    assert.equal(s.rainbow, "always");
    assert.equal(s.iconStyle, "nerd");
    assert.equal(s.strip.tokens, true);
  });
});

describe("settings cache", () => {
  it("is invalidated by saveFooterSettings (visible on immediate reload)", async () => {
    const { loadFooterSettings, saveFooterSettings } = await import("../src/config.ts");
    assert.equal(loadFooterSettings().enabled, true);
    // Within the 1s fresh window an un-invalidated cache would return stale.
    assert.equal(saveFooterSettings({ enabled: false }), true);
    assert.equal(loadFooterSettings().enabled, false);
  });

  it("picks up external file edits via the mtime re-check", async () => {
    const { loadFooterSettings, invalidateFooterSettingsCache } = await import("../src/config.ts");
    assert.equal(loadFooterSettings().processLine, true);
    invalidateFooterSettingsCache();
    // Touch the file with new content and a newer mtime.
    writeConfig({ processLine: false });
    const cfg = path.join(configDir(), "config.json");
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(cfg, future, future);
    assert.equal(loadFooterSettings().processLine, false);
  });
});
