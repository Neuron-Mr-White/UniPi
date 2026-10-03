/**
 * Settings metadata guard (UNI-50) — every settings-hub field must explain
 * itself in the info panel.
 *
 * Loads EVERY settings definition (23 namespaces across 23 schema files) and
 * walks every section — resolving getter-based page sections — asserting:
 *   1. every field (incl. page/action) has a non-empty description ≤ 140 chars
 *   2. every label is ≤ 24 chars
 *   3. every enum/multiselect option carries a description ≤ 60 chars,
 *      unless the field sets `plainOptions`
 *   4. no label ends in a unit suffix (` ms`, ` s`, `(min)`, `(days)`,
 *      ` bytes`) — units belong in the `unit` schema field
 *   5. field/page/action descriptions are sentences ending with "."; option
 *      descriptions are fragments that don't
 *
 * The failure message lists every violation as `namespace › key: rule`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { listSettingsDefinitions, type SettingsDefinition, type SettingsField, type SettingsSection } from "@pi-unipi/core";

// ── load every schema module (registration happens at import unless noted) ──
import "../packages/autocomplete/src/settings.ts";
import "../packages/background-tasks/src/config.ts";
import "../packages/compactor/src/config/manager.ts";
import "../packages/core/src/hints/index.ts";
import "../packages/core/src/jev/settings.ts";
import "../packages/footer/src/config.ts";
import "../packages/fusion/src/preset.ts";
import "../packages/input-shortcuts/src/settings.ts";
import { registerKanboardSettings } from "../packages/kanboard/src/settings.ts";
import "../packages/long-horizon/src/settings.ts";
import "../packages/mcp/src/settings.ts";
import "../packages/skill-registry/src/settings.ts";
import "../packages/subagents/src/index.ts";
import "../packages/updater/src/settings.ts";
import "../packages/utility/src/image/settings.ts";
import "../packages/utility/src/settings.ts";
import { registerWatchdogSettings } from "../packages/watchdog/src/config.ts";
import "../packages/web-api/src/settings.ts";
import { registerPermissionSettings } from "../packages/workflow/src/permission/settings.ts";
import "../packages/info-screen/config.ts";
import "../packages/memory/settings.ts";
import "../packages/notify/settings.ts";
import "../packages/ask-user/config.ts";

// Modules that register at activation (not import) — register explicitly.
registerKanboardSettings();
registerWatchdogSettings(process.cwd());
registerPermissionSettings();

const EXPECTED_NAMESPACES = 23;

const UNIT_SUFFIX = /\s(?:ms|s|min|days|bytes)$|\((?:min|days)\)$/;

function resolveSections(sections: readonly SettingsSection[] | (() => readonly SettingsSection[])): readonly SettingsSection[] {
  return typeof sections === "function" ? sections() : sections;
}

function walkFields(
  def: SettingsDefinition,
  fields: readonly SettingsField[],
  violations: string[],
): void {
  for (const field of fields) {
    const id = `${def.namespace} › ${field.key}`;
    const label = field.label ?? "";
    if (!field.description?.trim()) {
      violations.push(`${id}: description missing`);
    } else if (field.description.trim().length > 140) {
      violations.push(`${id}: description > 140 chars (${field.description.trim().length})`);
    }
    if (label.length > 24) {
      violations.push(`${id}: label > 24 chars ("${label}", ${label.length})`);
    }
    if (UNIT_SUFFIX.test(label)) {
      violations.push(`${id}: label ends in a unit suffix ("${label}") — move it to unit`);
    }
    const description = field.description?.trim() ?? "";
    if (description) {
      if (!description.endsWith(".")) violations.push(`${id}: description should end with "."`);
    }
    if (field.type === "enum" || field.type === "multiselect") {
      if (!field.plainOptions) {
        for (const option of field.options) {
          const value = typeof option === "string" ? option : option.value;
          const optionDescription = typeof option === "string" ? undefined : option.description?.trim();
          const oid = `${id} › option "${value}"`;
          if (!optionDescription) {
            violations.push(`${oid}: option description missing`);
          } else if (optionDescription.length > 60) {
            violations.push(`${oid}: option description > 60 chars (${optionDescription.length})`);
          } else if (optionDescription.endsWith(".")) {
            violations.push(`${oid}: option description is a fragment — drop the "."`);
          }
        }
      }
    }
    if (field.type === "page") {
      // Live-registry pages (footer groups, info-screen stats) may resolve
      // empty outside a session — walking what they yield is still correct.
      for (const section of resolveSections(field.sections)) {
        walkFields(def, section.fields, violations);
      }
    }
  }
}

test("every settings namespace passes the metadata guard", () => {
  const defs = listSettingsDefinitions().filter((d) => d.schema && d.schema.length > 0);
  assert.equal(
    defs.length,
    EXPECTED_NAMESPACES,
    `expected ${EXPECTED_NAMESPACES} schema namespaces, found ${defs.length}: ` +
      defs.map((d) => d.namespace).join(", "),
  );

  const violations: string[] = [];
  for (const def of defs) {
    for (const section of def.schema!) {
      walkFields(def, section.fields, violations);
    }
  }

  assert.equal(
    violations.length,
    0,
    `${violations.length} metadata violations across ${defs.length} namespaces:\n` +
      violations.join("\n"),
  );
});
