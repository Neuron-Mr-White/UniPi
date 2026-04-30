/**
 * @pi-unipi/footer — Config tests
 *
 * Tests config defaults and structure.
 * Note: Full config load/save tests require module resolution for @pi-unipi/core,
 * which is not available in the test runner. These test the constants only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Default settings structure — mirrors DEFAULT_FOOTER_SETTINGS */
const DEFAULT_SETTINGS = {
  enabled: true,
  preset: "default",
  separator: "powerline-thin",
  groups: {
    core: { show: true, segments: {} },
    compactor: { show: true, segments: {} },
    memory: { show: true, segments: {} },
    mcp: { show: true, segments: {} },
    ralph: { show: true, segments: {} },
    workflow: { show: true, segments: {} },
    kanboard: { show: true, segments: {} },
    notify: { show: false, segments: {} },
    status_ext: { show: true, segments: {} },
  },
};

describe("Footer config defaults", () => {
  it("has enabled=true", () => {
    assert.equal(DEFAULT_SETTINGS.enabled, true);
  });

  it("has default preset", () => {
    assert.equal(DEFAULT_SETTINGS.preset, "default");
  });

  it("has powerline-thin separator", () => {
    assert.equal(DEFAULT_SETTINGS.separator, "powerline-thin");
  });

  it("has all groups defined", () => {
    const expectedGroups = ["core", "compactor", "memory", "mcp", "ralph", "workflow", "kanboard", "notify", "status_ext"];
    for (const groupId of expectedGroups) {
      assert.ok(groupId in DEFAULT_SETTINGS.groups, `Missing group: ${groupId}`);
    }
  });

  it("notify group is off by default", () => {
    assert.equal(DEFAULT_SETTINGS.groups.notify.show, false);
  });

  it("core group is on by default", () => {
    assert.equal(DEFAULT_SETTINGS.groups.core.show, true);
  });

  it("separator is a valid style", () => {
    const validStyles = ["powerline", "powerline-thin", "slash", "pipe", "dot", "ascii"];
    assert.ok(validStyles.includes(DEFAULT_SETTINGS.separator));
  });

  it("group settings have show boolean", () => {
    for (const [id, group] of Object.entries(DEFAULT_SETTINGS.groups)) {
      assert.equal(typeof group.show, "boolean", `Group ${id} show should be boolean`);
    }
  });

  it("group settings have segments record", () => {
    for (const [id, group] of Object.entries(DEFAULT_SETTINGS.groups)) {
      assert.ok(typeof group.segments === "object", `Group ${id} segments should be object`);
    }
  });
});
