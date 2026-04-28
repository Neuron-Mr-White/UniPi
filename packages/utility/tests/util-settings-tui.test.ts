/**
 * @pi-unipi/utility — Util Settings TUI tests
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let origCwd: string;

describe("UtilSettingsTui", () => {
  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-tui-test-"));
    process.chdir(tmpDir);
    fs.mkdirSync(".unipi/config", { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports without error", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    assert.ok(UtilSettingsTui);
  });

  it("creates instance with default settings", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    assert.ok(tui);
  });

  it("renders without crashing", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    const lines = tui.render(60);
    assert.ok(lines.length > 0);
    assert.ok(lines[0].includes("╭")); // top border
    assert.ok(lines[lines.length - 1].includes("╯")); // bottom border
  });

  it("renders both badge and diff sections", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    const lines = tui.render(80);
    const text = lines.join("\n");
    assert.ok(text.includes("Badge"));
    assert.ok(text.includes("Diff Rendering"));
  });

  it("handles keyboard navigation", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    // Down arrow
    tui.handleInput("\x1b[B");
    // Up arrow
    tui.handleInput("\x1b[A");
    // Should not crash
  });

  it("handles space to toggle boolean", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    // Space to toggle
    tui.handleInput(" ");
    // Should not crash and should save
  });

  it("handles escape to close", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    let closed = false;
    tui.onClose = () => { closed = true; };
    tui.handleInput("\x1b");
    assert.ok(closed);
  });

  it("saves settings to util-settings.json on close", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    tui.onClose = () => {};
    tui.handleInput("\x1b");
    assert.ok(fs.existsSync(".unipi/config/util-settings.json"));
  });

  it("handles enter to enter picker mode", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    // Navigate to a picker setting (generationModel is index 3 in navItems)
    tui.handleInput("\x1b[B"); // down
    tui.handleInput("\x1b[B"); // down
    tui.handleInput("\x1b[B"); // down
    tui.handleInput("\r"); // enter
    // Should be in model picker mode — render should show models
    const lines = tui.render(80);
    const text = lines.join("\n");
    assert.ok(text.includes("inherit") || text.includes("Models"));
  });

  it("handles wide terminal width", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    const lines = tui.render(200);
    assert.ok(lines.length > 0);
  });

  it("handles narrow terminal width", async () => {
    const { UtilSettingsTui } = await import("../src/tui/util-settings-tui.js");
    const tui = new UtilSettingsTui();
    const lines = tui.render(30);
    assert.ok(lines.length > 0);
  });
});
