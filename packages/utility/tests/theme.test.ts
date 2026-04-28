/**
 * @pi-unipi/utility — Diff Theme tests
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;

describe("Diff Theme System", () => {
  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-theme-test-"));
    process.chdir(tmpDir);
    fs.mkdirSync(".unipi/config", { recursive: true });
    // Clean env vars
    delete process.env.DIFF_ADD_BG;
    delete process.env.DIFF_ADD_FG;
    delete process.env.DIFF_REM_BG;
    delete process.env.DIFF_REM_FG;
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DIFF_ADD_BG;
    delete process.env.DIFF_ADD_FG;
    delete process.env.DIFF_REM_BG;
    delete process.env.DIFF_REM_FG;
  });

  it("getPreset returns all 4 presets", async () => {
    const { getPreset, getPresetNames } = await import("../src/diff/theme.js");
    const names = getPresetNames();
    assert.deepEqual(names.sort(), ["default", "midnight", "neon", "subtle"].sort());
    for (const name of names) {
      const preset = getPreset(name);
      assert.equal(preset.name, name);
      assert.ok(preset.colors.addBg);
      assert.ok(preset.colors.remBg);
    }
  });

  it("getPreset falls back to default for unknown name", async () => {
    const { getPreset } = await import("../src/diff/theme.js");
    const preset = getPreset("nonexistent");
    assert.equal(preset.name, "default");
  });

  it("hex ↔ RGB round-trips correctly", async () => {
    const { hexToRgb, rgbToHex } = await import("../src/diff/theme.js");
    // Standard colors
    assert.deepEqual(hexToRgb("#ff0000"), [255, 0, 0]);
    assert.deepEqual(hexToRgb("#00ff00"), [0, 255, 0]);
    assert.deepEqual(hexToRgb("#0000ff"), [0, 0, 255]);
    // Round-trip
    assert.equal(rgbToHex(255, 128, 0), "#ff8000");
    assert.deepEqual(hexToRgb("#ff8000"), [255, 128, 0]);
    // Short form
    assert.deepEqual(hexToRgb("#f00"), [255, 0, 0]);
  });

  it("hex ↔ ANSI conversion round-trips", async () => {
    const { hexToFgAnsi, hexToBgAnsi, ansiFgToHex, ansiBgToHex } = await import("../src/diff/theme.js");
    const fgAnsi = hexToFgAnsi("#ff8800");
    assert.ok(fgAnsi.includes("38;2;255;136;0"));
    assert.equal(ansiFgToHex(fgAnsi), "#ff8800");

    const bgAnsi = hexToBgAnsi("#2255aa");
    assert.ok(bgAnsi.includes("48;2;34;85;170"));
    assert.equal(ansiBgToHex(bgAnsi), "#2255aa");
  });

  it("ansiFgToHex returns null for non-24bit ANSI", async () => {
    const { ansiFgToHex } = await import("../src/diff/theme.js");
    assert.equal(ansiFgToHex("\x1b[31m"), null); // 8-bit red
    assert.equal(ansiFgToHex("plain text"), null);
  });

  it("mixColors interpolates correctly", async () => {
    const { mixColors } = await import("../src/diff/theme.js");
    // 50/50 mix of red and blue
    const mixed = mixColors("#ff0000", "#0000ff", 0.5);
    assert.equal(mixed, "#800080"); // purple
    // Full foreground
    assert.equal(mixColors("#ff0000", "#0000ff", 1.0), "#ff0000");
    // Full background
    assert.equal(mixColors("#ff0000", "#0000ff", 0.0), "#0000ff");
  });

  it("resolveDiffColors falls back to preset when no theme", async () => {
    // Write util-settings with default theme
    fs.writeFileSync(
      ".unipi/config/util-settings.json",
      JSON.stringify({
        badge: { autoGen: true, badgeEnabled: true, agentTool: true, generationModel: "inherit" },
        diff: { enabled: true, theme: "default", shikiTheme: "github-dark", splitMinWidth: 150 },
      }),
    );
    const { resolveDiffColors, getPreset } = await import("../src/diff/theme.js");
    const colors = resolveDiffColors();
    const preset = getPreset("default");
    assert.deepEqual(colors, preset.colors);
  });

  it("resolveDiffColors applies env var overrides", async () => {
    fs.writeFileSync(
      ".unipi/config/util-settings.json",
      JSON.stringify({
        badge: { autoGen: true, badgeEnabled: true, agentTool: true, generationModel: "inherit" },
        diff: { enabled: true, theme: "default", shikiTheme: "github-dark", splitMinWidth: 150 },
      }),
    );
    process.env.DIFF_ADD_BG = "#123456";
    const { resolveDiffColors } = await import("../src/diff/theme.js");
    const colors = resolveDiffColors();
    assert.equal(colors.addBg, "#123456");
    // Other colors should remain from preset
    assert.ok(colors.remBg !== "#123456");
  });

  it("resolveDiffColors ignores invalid env var values", async () => {
    fs.writeFileSync(
      ".unipi/config/util-settings.json",
      JSON.stringify({
        badge: { autoGen: true, badgeEnabled: true, agentTool: true, generationModel: "inherit" },
        diff: { enabled: true, theme: "default", shikiTheme: "github-dark", splitMinWidth: 150 },
      }),
    );
    process.env.DIFF_ADD_BG = "not-a-color";
    const { resolveDiffColors, getPreset } = await import("../src/diff/theme.js");
    const colors = resolveDiffColors();
    const preset = getPreset("default");
    assert.equal(colors.addBg, preset.colors.addBg); // unchanged
  });

  it("applyDiffPalette returns ANSI wrapper functions", async () => {
    fs.writeFileSync(
      ".unipi/config/util-settings.json",
      JSON.stringify({
        badge: { autoGen: true, badgeEnabled: true, agentTool: true, generationModel: "inherit" },
        diff: { enabled: true, theme: "neon", shikiTheme: "github-dark", splitMinWidth: 150 },
      }),
    );
    const { applyDiffPalette } = await import("../src/diff/theme.js");
    const palette = applyDiffPalette();
    assert.equal(palette.colors.addBg, "#003300");
    // Test that wrapper functions produce ANSI output
    const result = palette.addBg("test");
    assert.ok(result.includes("48;2;0;51;0"));
    assert.ok(result.includes("test"));
  });
});
