/**
 * @pi-unipi/utility — Settings inspector tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSettingsInspector,
  getFilteredSchemas,
  applyAction,
  validateValue,
  validateAll,
  exportToJSON,
  importFromJSON,
} from "../src/tui/settings-inspector.ts";
import type { SettingSchema } from "../src/types.ts";

const TEST_SCHEMAS: SettingSchema[] = [
  {
    key: "theme",
    type: "string",
    description: "UI theme",
    default: "dark",
  },
  {
    key: "maxItems",
    type: "number",
    description: "Max items to show",
    default: 10,
  },
  {
    key: "enabled",
    type: "boolean",
    description: "Enable feature",
    default: true,
  },
];

describe("createSettingsInspector", () => {
  it("creates initial state with defaults", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    assert.equal(state.values.theme, "dark");
    assert.equal(state.values.maxItems, 10);
    assert.equal(state.values.enabled, true);
    assert.equal(state.selectedIndex, 0);
  });
});

describe("getFilteredSchemas", () => {
  it("returns all schemas when no search", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    assert.equal(getFilteredSchemas(state).length, 3);
  });

  it("filters by key", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const updated = applyAction(state, { type: "search", query: "theme" });
    assert.equal(getFilteredSchemas(updated.state).length, 1);
  });

  it("filters by description", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const updated = applyAction(state, { type: "search", query: "feature" });
    assert.equal(getFilteredSchemas(updated.state).length, 1);
  });
});

describe("applyAction", () => {
  it("navigates up and down", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    let result = applyAction(state, { type: "navigate", direction: "down" });
    assert.equal(result.state.selectedIndex, 1);
    result = applyAction(result.state, { type: "navigate", direction: "up" });
    assert.equal(result.state.selectedIndex, 0);
  });

  it("edits a value", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const result = applyAction(state, { type: "edit", value: "light" });
    assert.equal(result.state.values.theme, "light");
    assert.equal(result.changed, true);
  });

  it("toggles edit mode", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const result = applyAction(state, { type: "toggle_edit" });
    assert.equal(result.state.editMode, true);
  });

  it("saves", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const result = applyAction(state, { type: "save" });
    assert.equal(result.saved, true);
  });
});

describe("validateValue", () => {
  it("validates string type", () => {
    const schema = TEST_SCHEMAS[0];
    assert.equal(validateValue(schema, "hello"), undefined);
    assert.ok(validateValue(schema, 123)?.includes("string"));
  });

  it("validates number type", () => {
    const schema = TEST_SCHEMAS[1];
    assert.equal(validateValue(schema, 42), undefined);
    assert.ok(validateValue(schema, "42")?.includes("number"));
  });

  it("validates boolean type", () => {
    const schema = TEST_SCHEMAS[2];
    assert.equal(validateValue(schema, false), undefined);
    assert.ok(validateValue(schema, "true")?.includes("boolean"));
  });

  it("checks required fields", () => {
    const schema: SettingSchema = {
      key: "required",
      type: "string",
      description: "Required field",
      required: true,
    };
    assert.ok(validateValue(schema, undefined)?.includes("Required"));
  });
});

describe("export/import JSON", () => {
  it("round-trips values", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const json = exportToJSON(state);
    const imported = importFromJSON(state, json);
    assert.equal(imported.state.values.theme, "dark");
    assert.equal(Object.keys(imported.errors).length, 0);
  });

  it("reports invalid JSON", () => {
    const state = createSettingsInspector(TEST_SCHEMAS);
    const imported = importFromJSON(state, "not json");
    assert.ok(imported.errors._parse?.includes("Invalid JSON"));
  });
});
