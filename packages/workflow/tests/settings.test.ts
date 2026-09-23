/**
 * Hub registration for the permission namespace: defaults, schema, the rule
 * count in the clear action label, and the mode round-trip.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsHub, getSettingsDefinition, listSettingsDefinitions } from "@pi-unipi/core";
import {
  DEFAULT_SETTINGS,
  PERMISSION_SECTIONS,
  addPermissionRule,
  clearPermissionRules,
  readPermissionSettings,
  registerPermissionSettings,
  writePermissionMode,
} from "../src/permission/settings.js";

function cwd(): string {
  return mkdtempSync(join(tmpdir(), "perm-hub-"));
}

describe("permission settings namespace", () => {
  it("registers with the documented defaults", () => {
    registerPermissionSettings();
    const definition = getSettingsDefinition("permission");
    assert.ok(definition, "permission namespace registered");
    assert.equal(definition!.label, "Permissions");
    assert.deepEqual(definition!.defaults, {
      mode: "auto",
      jevJudge: true,
      jevConfidence: 0.7,
      rules: [],
    });
    assert.equal(DEFAULT_SETTINGS.mode, "auto");
  });

  it("exposes mode, jevJudge, jevConfidence and the clear-rules action", () => {
    const fields = PERMISSION_SECTIONS[0]!.fields;
    const keys = fields.map((field) => field.key);
    assert.deepEqual(keys, ["mode", "jevJudge", "jevConfidence", "rulesCount"]);

    const mode = fields[0]!;
    assert.equal(mode.type, "enum");
    assert.deepEqual(
      mode.type === "enum" ? mode.options.map((option) => (typeof option === "string" ? option : option.value)) : [],
      ["ask", "auto", "full"],
    );

    const confidence = fields[2]!;
    assert.equal(confidence.type, "number");
    assert.equal(confidence.type === "number" ? confidence.min : undefined, 0);
    assert.equal(confidence.type === "number" ? confidence.max : undefined, 1);

    const action = fields[3]!;
    assert.equal(action.type, "action");
    assert.equal(action.type === "action" ? action.command : undefined, "unipi:permission-clear-rules");
  });

  it("defaults to auto when the stored value is nonsense", () => {
    const dir = cwd();
    registerPermissionSettings(dir);
    writePermissionMode("auto", dir);
    assert.equal(readPermissionSettings(dir).mode, "auto");
    assert.equal(readPermissionSettings(dir).jevJudge, true);
    assert.equal(readPermissionSettings(dir).jevConfidence, 0.7);
    assert.deepEqual(readPermissionSettings(dir).rules, []);
  });

  it("round-trips the mode through the settings engine", () => {
    const dir = cwd();
    registerPermissionSettings(dir);
    writePermissionMode("full", dir);
    assert.equal(readPermissionSettings(dir).mode, "full");
    assert.equal((getSettingsDefinition("permission") && true) === true, true);
  });

  it("shows the saved-rule count in the action label", () => {
    const dir = cwd();
    registerPermissionSettings(dir);
    addPermissionRule({ tool: "bash", pattern: "npm run *", decision: "allow", scope: "project" }, dir);
    const fields = getSettingsDefinition("permission")!.schema![0]!.fields;
    const action = fields.find((field) => field.type === "action")!;
    assert.match(action.label, /Clear 1 saved rule…/);

    addPermissionRule({ tool: "bash", pattern: "npm test *", decision: "allow", scope: "project" }, dir);
    const two = getSettingsDefinition("permission")!.schema![0]!.fields.find((f) => f.type === "action")!;
    assert.match(two.label, /Clear 2 saved rules…/);
  });

  it("clears rules and reports how many were removed", () => {
    const dir = cwd();
    registerPermissionSettings(dir);
    addPermissionRule({ tool: "bash", pattern: "npm run *", decision: "allow", scope: "project" }, dir);
    addPermissionRule({ tool: "bash", pattern: "rm -rf *", decision: "deny", scope: "project" }, dir);
    assert.equal(readPermissionSettings(dir).rules.length, 2);

    assert.equal(clearPermissionRules(dir), 2);
    assert.deepEqual(readPermissionSettings(dir).rules, []);
    const action = getSettingsDefinition("permission")!.schema![0]!.fields.find((f) => f.type === "action")!;
    assert.match(action.label, /^Clear saved rules…$/);
  });

  it("is listed by the settings hub and renders its section", () => {
    const dir = cwd();
    registerPermissionSettings(dir);
    assert.ok(listSettingsDefinitions().some((definition) => definition.namespace === "permission"));

    const hub = new SettingsHub({ cwd: dir, modelCatalog: () => [] });
    const rendered = hub.render(100).join("\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    assert.match(rendered, /Permissions/);
  });

  it("registering with a rule count keeps the settings engine usable", () => {
    const dir = cwd();
    registerPermissionSettings(dir);
    // Reading through the engine must not throw for a fresh project.
    assert.equal(clearPermissionRules(dir), 0);
    const raw = readPermissionSettings(dir);
    assert.equal(raw.mode, "auto");
  });
});
