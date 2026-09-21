import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  migrateToV3Layout,
  readLedger,
  CURRENT_SETTINGS_VERSION,
} from "./src/settings/migrations.js";
import {
  getSettings,
  listSettingsDefinitions,
  registerSettings,
  setSettings,
  settingsLayers,
} from "./src/settings/engine.js";
import { globalSettingsPath, projectSettingsPath, migrationLedgerPath } from "./src/settings/paths.js";

const originalHome = process.env.HOME;

/**
 * Sandbox HOME + cwd so the migration touches nothing real. The modules under
 * test read paths via homedir()/cwd at CALL time, so per-test env flips work.
 */
function sandbox(): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "lh-settings-mig-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.HOME = home;
  return { home, cwd };
}

function restore(home: string, cwd: string): void {
  process.env.HOME = originalHome;
  rmSync(join(home, ".."), { recursive: true, force: true });
}

function writePiSettings(home: string, data: unknown): void {
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify(data, null, 2));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

test("layout A: unipi.* keys move to module dirs and are stripped from pi settings", () => {
  const { home, cwd } = sandbox();
  writePiSettings(home, {
    unipi: {
      longHorizon: { judge: { enabled: true } },
      askUser: { enabled: false },
      foreignKey: { keep: true }, // not ours — must stay
    },
    piNative: { model: "x" },
  });

  const result = migrateToV3Layout(cwd);
  assert.equal(result.ran, true);

  // Moved into module dirs.
  assert.deepEqual(readJson(globalSettingsPath("long-horizon")), { judge: { enabled: true } });
  assert.deepEqual(readJson(globalSettingsPath("ask-user")), { enabled: false });
  // ask-user module dir uses kebab namespace.
  assert.equal(existsSync(globalSettingsPath("footer")), false); // absent key → skipped

  // pi settings: our keys stripped, foreign keys and pi-native untouched.
  const piSettings = readJson(join(home, ".pi", "agent", "settings.json"));
  assert.deepEqual(piSettings.piNative, { model: "x" }); // pi-native untouched
  assert.deepEqual((piSettings.unipi as Record<string, unknown>).foreignKey, { keep: true });
  assert.equal((piSettings.unipi as Record<string, unknown>).longHorizon, undefined);

  // Ledger written with the moves logged.
  const ledger = readLedger();
  assert.equal(ledger?.version, CURRENT_SETTINGS_VERSION);
  assert.ok(ledger?.log.some((entry) => entry.action === "moved" && entry.to === globalSettingsPath("long-horizon")));

  restore(home, cwd);
});

test("layout C: project override shapes unify into <module>/config.json", () => {
  const { home, cwd } = sandbox();
  mkdirSync(join(cwd, ".unipi", "config"), { recursive: true });
  writeFileSync(join(cwd, ".unipi", "config", "compactor.json"), '{"threshold":80}');
  writeFileSync(join(cwd, ".unipi", "fusion-preset.json"), '{"lead":"zai/glm-4.7"}');
  writeFileSync(join(cwd, ".unipi", "config", "background-tasks.json"), '{"maxTasks":9}');

  const result = migrateToV3Layout(cwd);
  assert.equal(result.ran, true);
  assert.deepEqual(readJson(projectSettingsPath(cwd, "compactor")), { threshold: 80 });
  assert.deepEqual(readJson(projectSettingsPath(cwd, "fusion")), { lead: "zai/glm-4.7" });
  assert.deepEqual(readJson(projectSettingsPath(cwd, "background-tasks")), { maxTasks: 9 });
  // Legacy shapes gone.
  assert.equal(existsSync(join(cwd, ".unipi", "config", "compactor.json")), false);
  assert.equal(existsSync(join(cwd, ".unipi", "fusion-preset.json")), false);
  assert.equal(existsSync(join(cwd, ".unipi", "config", "background-tasks.json")), false);
  restore(home, cwd);
});

test("conflict: existing target is never clobbered; legacy stays", () => {
  const { home, cwd } = sandbox();
  const legacy = join(cwd, ".unipi", "config", "compactor.json");
  mkdirSync(join(cwd, ".unipi", "config", "compactor"), { recursive: true });
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, '{"old":true}');
  writeFileSync(projectSettingsPath(cwd, "compactor"), '{"new":true}');

  const result = migrateToV3Layout(cwd);
  assert.equal(result.ran, true);
  assert.deepEqual(readJson(projectSettingsPath(cwd, "compactor")), { new: true });
  assert.equal(existsSync(legacy), true); // kept for manual resolution
  assert.ok(result.ledger.log.some((entry) => entry.action === "conflict:kept-existing"));
  restore(home, cwd);
});

test("idempotent: second run is a no-op with the ledger", () => {
  const { home, cwd } = sandbox();
  writePiSettings(home, { unipi: { footer: { preset: "glance" } } });
  const first = migrateToV3Layout(cwd);
  assert.equal(first.ran, true);
  const second = migrateToV3Layout(cwd);
  assert.equal(second.ran, false);
  assert.equal(second.reason, "already-applied");
  restore(home, cwd);
});

test("backup captures pi settings and legacy files before removal", () => {
  const { home, cwd } = sandbox();
  writePiSettings(home, { unipi: { infoScreen: { dense: true } } });
  mkdirSync(join(cwd, ".unipi", "config"), { recursive: true });
  writeFileSync(join(cwd, ".unipi", "config", "compactor.json"), "{}");
  migrateToV3Layout(cwd);
  const backupRoot = join(home, ".unipi", "config", ".backup", "pre-3.0.0");
  assert.equal(existsSync(join(backupRoot, ".pi", "agent", "settings.json")), true);
  const projectBackup = join(backupRoot, "abs", cwd.replace(/^\//, ""), ".unipi", "config", "compactor.json");
  assert.equal(existsSync(projectBackup), true);
  restore(home, cwd);
});

// ── engine ───────────────────────────────────────────────────────────────

test("engine: defaults ⊕ global ⊕ project, workspace wins; scoped writes", () => {
  const { home, cwd } = sandbox();
  registerSettings({
    namespace: "test-mod",
    label: "Test",
    defaults: { a: 1, nested: { x: 1, y: 2 } },
  });
  // Register in a fresh registry sense — engine has module-scope registry;
  // write global + project directly and read layered.
  mkdirSync(join(home, ".unipi", "config", "test-mod"), { recursive: true });
  writeFileSync(globalSettingsPath("test-mod"), JSON.stringify({ nested: { x: 10 } }));
  mkdirSync(join(cwd, ".unipi", "config", "test-mod"), { recursive: true });
  writeFileSync(projectSettingsPath(cwd, "test-mod"), JSON.stringify({ a: 99 }));

  const effective = getSettings("test-mod", cwd);
  assert.deepEqual(effective, { a: 99, nested: { x: 10, y: 2 } });

  setSettings("test-mod", { nested: { y: 20 } }, "global", cwd);
  assert.deepEqual(readJson(globalSettingsPath("test-mod")), { nested: { x: 10, y: 20 } });

  const layers = settingsLayers("test-mod", cwd);
  assert.deepEqual(layers, { global: true, project: true });
  assert.ok(listSettingsDefinitions().some((definition) => definition.namespace === "test-mod"));
  restore(home, cwd);
});

test("engine: modules can opt out of project overrides", () => {
  const { home, cwd } = sandbox();
  registerSettings({ namespace: "global-only", label: "G", defaults: { z: 0 }, projectOverrides: false });
  assert.throws(() => setSettings("global-only", { z: 1 }, "project", cwd), /does not support project overrides/);
  const layers = settingsLayers("global-only", cwd);
  assert.equal(layers.project, false);
  restore(home, cwd);
});
