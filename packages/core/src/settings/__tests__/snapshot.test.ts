import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { registerSettings } from "../engine.js";
import type { SettingsSection } from "../schema.js";
import { buildSettingsSnapshot, writeSettingsSnapshot, type SettingsSnapshot } from "../snapshot.js";

const originalHome = process.env.HOME;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "unipi-snapshot-"));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

// Unique-per-run namespaces dodge the process-global registry (same trick as
// the hub tests).
let run = 0;

function ns(): string {
  return `snaptest${++run}`;
}

function register(name: string, schema: SettingsSection[], extra: Record<string, unknown> = {}): void {
  registerSettings({
    namespace: name,
    label: "Snapshot Test",
    defaults: { flag: true },
    schema,
    ...extra,
  });
}

function readSnapshot(): SettingsSnapshot {
  const raw = readFileSync(join(home, ".unipi", "config", "settings-schema.json"), "utf8");
  return JSON.parse(raw) as SettingsSnapshot;
}

test("snapshot keeps plain fields and drops functions (validated flag)", () => {
  const name = ns();
  register(name, [
    {
      title: "Fields",
      fields: [
        { key: "flag", type: "boolean", label: "Flag" },
        { key: "text", type: "string", label: "Text", emptyLabel: "inherit", validate: (raw) => (raw.length > 3 ? null : "too short") },
        { key: "count", type: "number", label: "Count", min: 0, max: 10, unit: "ms", zeroLabel: "off" },
        { key: "token", type: "secret", label: "Token" },
        { key: "action", type: "action", label: "Rebuild", command: "unipi:rebuild" },
      ],
    },
  ]);
  const snap = buildSettingsSnapshot();
  const def = snap.namespaces.find((n) => n.namespace === name);
  assert.ok(def, "the registered namespace is in the snapshot");
  const fields = def.sections[0]!.fields;
  const text = fields.find((f) => f.key === "text")!;
  assert.equal(text.type, "string");
  assert.equal(text.validated, true, "validate → validated: true");
  assert.ok(!("validate" in text), "the function itself is gone");
  const plain = fields.find((f) => f.key === "flag")!;
  assert.notEqual(plain.validated, true, "no validate → no validated flag");
  const count = fields.find((f) => f.key === "count")!;
  assert.deepEqual({ min: count.min, max: count.max, unit: count.unit, zeroLabel: count.zeroLabel }, { min: 0, max: 10, unit: "ms", zeroLabel: "off" });
  const action = fields.find((f) => f.key === "action")!;
  assert.equal(action.type, "action");
  assert.ok(!("command" in action) === false && action.command === "unipi:rebuild");
  const section = def.sections[0]!;
  assert.equal(section.title, "Fields");
});

test("enum/multiselect options are normalised via enumOption", () => {
  const name = ns();
  register(name, [
    {
      title: "Options",
      fields: [
        { key: "level", type: "enum", label: "Level", options: ["low", { value: "high", label: "High", description: "full power" }], plainOptions: true, allowCustom: true, hint: "pick one", clearable: true, scope: "global" },
        { key: "tags", type: "multiselect", label: "Tags", options: [{ value: "a", label: "Alpha" }], emptyLabel: "none" },
      ],
    },
  ]);
  const snap = buildSettingsSnapshot();
  const def = snap.namespaces.find((n) => n.namespace === name)!;
  const level = def.sections[0]!.fields.find((f) => f.key === "level")!;
  assert.deepEqual(level.options, [
    { value: "low", label: "low" },
    { value: "high", label: "High", description: "full power" },
  ]);
  assert.equal(level.plainOptions, true);
  assert.equal(level.allowCustom, true);
  assert.equal(level.scope, "global");
  assert.equal(level.clearable, true);
  const tags = def.sections[0]!.fields.find((f) => f.key === "tags")!;
  assert.deepEqual(tags.options, [{ value: "a", label: "Alpha" }]);
});

test("page getter is resolved; nested pages recurse; order items are resolved", () => {
  const name = ns();
  register(name, [
    {
      title: "Pages",
      fields: [
        {
          key: "providers.acme",
          type: "page",
          label: "acme",
          sections: () => [
            { title: "acme", fields: [{ key: "providers.acme.key", type: "secret", label: "Key" }] },
          ],
        },
        {
          key: "layout",
          type: "order",
          label: "Layout",
          items: () => [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
          ],
        },
      ],
    },
  ]);
  const snap = buildSettingsSnapshot();
  const def = snap.namespaces.find((n) => n.namespace === name)!;
  const page = def.sections[0]!.fields.find((f) => f.key === "providers.acme")!;
  assert.equal(page.type, "page");
  assert.ok(!("summary" in page));
  const inner = page.sections[0]!.fields[0]!;
  assert.equal(inner.type, "secret");
  const order = def.sections[0]!.fields.find((f) => f.key === "layout")!;
  assert.deepEqual(order.items, [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
  ]);
});

test("model fields keep presets/providerKey, drop filter into filtered", () => {
  const name = ns();
  register(name, [
    {
      title: "Models",
      fields: [
        { key: "provider", type: "enum", label: "Provider", options: ["prov", "other"] },
        {
          key: "model",
          type: "model",
          label: "Model",
          provider: "prov",
          capability: "text",
          emptyLabel: "inherit",
          presets: ["prov/m1", "prov/m2"],
          presetsByProvider: { other: ["other/x1"] },
          emptyOption: "inherit (session model)",
          providerKey: "provider",
          filter: (entry) => entry.input.includes("text"),
        },
      ],
    },
  ]);
  const snap = buildSettingsSnapshot();
  const def = snap.namespaces.find((n) => n.namespace === name)!;
  const model = def.sections[0]!.fields.find((f) => f.key === "model")!;
  assert.equal(model.type, "model");
  assert.deepEqual(model.presets, ["prov/m1", "prov/m2"]);
  assert.deepEqual(model.presetsByProvider, { other: ["other/x1"] });
  assert.equal(model.providerKey, "provider");
  assert.equal(model.emptyOption, "inherit (session model)");
  assert.equal(model.filtered, true, "filter existed");
  assert.ok(!("filter" in model), "the function itself is gone");
});

test("mirrored flag reflects onSet; projectOverrides/defaults ride along", () => {
  const name = ns();
  let writes = 0;
  register(
    name,
    [{ title: "S", fields: [{ key: "flag", type: "boolean", label: "Flag" }] }],
    {
      projectOverrides: false,
      onSet: () => {
        writes++;
      },
    },
  );
  const snap = buildSettingsSnapshot();
  const def = snap.namespaces.find((n) => n.namespace === name)!;
  assert.equal(def.mirrored, true);
  assert.equal(def.projectOverrides, false);
  assert.deepEqual(def.defaults, { flag: true });
  assert.equal(writes, 0, "building a snapshot never calls onSet");
});

test("a throwing getter skips its field; the snapshot still builds", () => {
  const name = ns();
  register(name, [
    {
      title: "Broken",
      fields: [
        { key: "fine", type: "boolean", label: "Fine" },
        {
          key: "boom",
          type: "order",
          label: "Boom",
          items: () => {
            throw new Error("catalog not ready");
          },
        },
        {
          key: "boomPage",
          type: "page",
          label: "Boom page",
          sections: () => {
            throw new Error("registry offline");
          },
        },
      ],
    },
  ]);
  const snap = buildSettingsSnapshot();
  const def = snap.namespaces.find((n) => n.namespace === name)!;
  const keys = def.sections[0]!.fields.map((f) => f.key);
  assert.deepEqual(keys, ["fine"], "only the healthy field survives");
});

test("writeSettingsSnapshot writes atomically and skips a no-op rewrite", () => {
  const name = ns();
  register(name, [{ title: "S", fields: [{ key: "flag", type: "boolean", label: "Flag" }] }]);
  assert.ok(!existsSync(join(home, ".unipi")), "nothing written before the first publish");
  writeSettingsSnapshot();
  const file = join(home, ".unipi", "config", "settings-schema.json");
  assert.ok(existsSync(file), "the snapshot landed");
  const first = readFileSync(file, "utf8");
  assert.ok(first.trimEnd().endsWith("}"));
  const parsed = JSON.parse(first) as SettingsSnapshot;
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.writtenAt, "string");
  const def = parsed.namespaces.find((n) => n.namespace === name);
  assert.ok(def, "the namespace is on disk");

  // A new clock tick alone must not rewrite the file.
  const before = readFileSync(file, "utf8");
  writeSettingsSnapshot();
  assert.equal(readFileSync(file, "utf8"), before, "writtenAt-only changes do not rewrite");

  // A real schema change does.
  register(name, [{ title: "S", fields: [{ key: "flag", type: "boolean", label: "Flag" }, { key: "extra", type: "string", label: "Extra" }] }]);
  writeSettingsSnapshot();
  const after = readFileSync(file, "utf8");
  assert.notEqual(after, before, "new fields rewrite the file");
  assert.ok(JSON.parse(after).namespaces.find((n) => n.namespace === name)!.sections[0]!.fields.some((f) => f.key === "extra"));
  assert.ok(!existsSync(`${file}.tmp`), "the tmp file never survives");
});

test("unipiVersion is included when the core package.json is resolvable", () => {
  register(ns(), [{ title: "S", fields: [] }]);
  const snap = buildSettingsSnapshot();
  assert.match(snap.unipiVersion ?? "", /^\d+\.\d+\.\d+/);
});
