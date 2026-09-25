import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  importGlobalScope,
  importProjectScope,
  finalizeGlobalScope,
  finalizeProjectScope,
  CURRENT_SETTINGS_VERSION,
} from "./src/settings/migrations.js";
import {
  getSettings,
  listSettingsDefinitions,
  registerSettings,
  resetSettingsGates,
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
  resetSettingsGates(); // fresh process-start semantics per test
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

  const result = importGlobalScope();
  assert.equal(result.ran, true);

  // Copied into module dirs.
  assert.deepEqual(readJson(globalSettingsPath("long-horizon")), { judge: { enabled: true } });
  assert.deepEqual(readJson(globalSettingsPath("ask-user")), { enabled: false });
  // ask-user module dir uses kebab namespace.
  assert.equal(existsSync(globalSettingsPath("footer")), false); // absent key → skipped

  // IMPORT IS COPY-ONLY: pi settings keeps ALL keys — a v2 install sharing
  // this machine still reads its unipi.* view and keeps working.
  const piSettings = readJson(join(home, ".pi", "agent", "settings.json"));
  assert.deepEqual(piSettings.piNative, { model: "x" });
  assert.deepEqual((piSettings.unipi as Record<string, unknown>).foreignKey, { keep: true });
  assert.deepEqual((piSettings.unipi as Record<string, unknown>).longHorizon, { judge: { enabled: true } });
  assert.deepEqual((piSettings.unipi as Record<string, unknown>).askUser, { enabled: false });

  // Ledger: imported but NOT finalized.
  const ledger = JSON.parse(readFileSync(migrationLedgerPath(), "utf-8"));
  assert.equal(ledger.migrated_version, CURRENT_SETTINGS_VERSION);
  assert.equal(ledger.finalized, false);
  assert.ok(ledger.log.some((entry: { action: string; to?: string }) => entry.action === "copied" && entry.to === globalSettingsPath("long-horizon")));

  // FINALIZE (explicit): our keys stripped, foreign keys stay, v2 view ends.
  finalizeGlobalScope();
  const afterFinalize = readJson(join(home, ".pi", "agent", "settings.json"));
  assert.deepEqual((afterFinalize.unipi as Record<string, unknown>).foreignKey, { keep: true });
  assert.equal((afterFinalize.unipi as Record<string, unknown>).longHorizon, undefined);
  const finalizedLedger = JSON.parse(readFileSync(migrationLedgerPath(), "utf-8"));
  assert.equal(finalizedLedger.finalized, true);

  restore(home, cwd);
});

test("layout D: v2 global flat module configs copy into the canonical shape", () => {
  const { home, cwd } = sandbox();
  const legacy = join(home, ".unipi", "memory", "config.json");
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ mempalaceAutoUpdate: false, provider: "none" }));

  const result = importGlobalScope();
  assert.equal(result.ran, true);

  // Copied into the canonical shape; the legacy file stays for v2 sessions.
  assert.deepEqual(readJson(globalSettingsPath("memory")), { mempalaceAutoUpdate: false, provider: "none" });
  assert.ok(existsSync(legacy), "legacy file left in place");
  assert.ok(result.ledger.log.some((e) => e.action === "copied" && e.from.includes("memory")));

  // Existing canonical config is never clobbered.
  const { home: h2 } = sandbox();
  mkdirSync(join(h2, ".unipi", "memory"), { recursive: true });
  writeFileSync(join(h2, ".unipi", "memory", "config.json"), JSON.stringify({ mempalaceAutoUpdate: false }));
  mkdirSync(join(h2, ".unipi", "config", "memory"), { recursive: true });
  writeFileSync(globalSettingsPath("memory"), JSON.stringify({ mempalaceAutoUpdate: true }));
  importGlobalScope();
  assert.equal(readJson(globalSettingsPath("memory")).mempalaceAutoUpdate, true);
});

test("layout C: project override shapes unify into <module>/config.json", () => {
  const { home, cwd } = sandbox();
  mkdirSync(join(cwd, ".unipi", "config"), { recursive: true });
  writeFileSync(join(cwd, ".unipi", "config", "compactor.json"), '{"threshold":80}');
  writeFileSync(join(cwd, ".unipi", "fusion-preset.json"), '{"lead":"zai/glm-4.7"}');
  writeFileSync(join(cwd, ".unipi", "config", "background-tasks.json"), '{"maxTasks":9}');

  const result = importProjectScope(cwd);
  assert.equal(result.ran, true);
  assert.deepEqual(readJson(projectSettingsPath(cwd, "compactor")), { threshold: 80 });
  assert.deepEqual(readJson(projectSettingsPath(cwd, "fusion")), { lead: "zai/glm-4.7" });
  assert.deepEqual(readJson(projectSettingsPath(cwd, "background-tasks")), { maxTasks: 9 });
  // IMPORT IS COPY-ONLY: legacy shapes remain for v2 sessions in this project.
  assert.equal(existsSync(join(cwd, ".unipi", "config", "compactor.json")), true);
  assert.equal(existsSync(join(cwd, ".unipi", "fusion-preset.json")), true);
  assert.equal(existsSync(join(cwd, ".unipi", "config", "background-tasks.json")), true);
  // FINALIZE (explicit): legacy removed after verified copies exist.
  finalizeProjectScope(cwd);
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

  const result = importProjectScope(cwd);
  assert.equal(result.ran, true);
  assert.deepEqual(readJson(projectSettingsPath(cwd, "compactor")), { new: true });
  assert.equal(existsSync(legacy), true); // kept for manual resolution
  assert.ok(result.ledger.log.some((entry) => entry.action === "conflict:kept-existing"));
  restore(home, cwd);
});

test("idempotent: second run is a no-op with the ledger", () => {
  const { home, cwd } = sandbox();
  writePiSettings(home, { unipi: { footer: { preset: "glance" } } });
  const first = importGlobalScope();
  assert.equal(first.ran, true);
  const second = importGlobalScope();
  assert.equal(second.ran, false);
  assert.equal(second.reason, "already-migrated");
  restore(home, cwd);
});

test("backup captures pi settings and legacy files before removal", () => {
  const { home, cwd } = sandbox();
  writePiSettings(home, { unipi: { infoScreen: { dense: true } } });
  mkdirSync(join(cwd, ".unipi", "config"), { recursive: true });
  writeFileSync(join(cwd, ".unipi", "config", "compactor.json"), "{}");
  importGlobalScope();
  importProjectScope(cwd);
  finalizeGlobalScope();
  finalizeProjectScope(cwd);
  // Global backup: pi settings.json (layout A source).
  const globalBackup = join(home, ".unipi", "config", ".backup", "pre-3.0.0");
  assert.equal(existsSync(join(globalBackup, ".pi", "agent", "settings.json")), true);
  // Project backup: the legacy override, under the project's own backup dir.
  const projectBackup = join(cwd, ".unipi", "config", ".backup", "pre-3.0.0", "abs", cwd.replace(/^\//, ""), ".unipi", "config", "compactor.json");
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

test("coexistence: v3 import does not disturb a v2 session's view (both on one PC)", () => {
  const { home, cwd } = sandbox();
  writePiSettings(home, {
    unipi: { footer: { preset: "glance" }, askUser: { enabled: true } },
    piNative: { theme: "dark" },
  });
  mkdirSync(join(cwd, ".unipi", "config"), { recursive: true });
  writeFileSync(join(cwd, ".unipi", "config", "compactor.json"), '{"threshold":90}');

  // v3 session: first settings access runs the IMPORT gates.
  registerSettings({ namespace: "coexist-test", label: "C", defaults: { x: 1 } });
  getSettings("coexist-test", cwd);

  // v3 sees the imported data.
  assert.deepEqual(readJson(globalSettingsPath("footer")), { preset: "glance" });
  assert.deepEqual(readJson(projectSettingsPath(cwd, "compactor")), { threshold: 90 });

  // v2 session (same machine, same project) reads its legacy locations:
  // everything is still there — untouched.
  const v2View = readJson(join(home, ".pi", "agent", "settings.json"));
  assert.deepEqual((v2View.unipi as Record<string, unknown>).footer, { preset: "glance" });
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, ".unipi", "config", "compactor.json"), "utf-8")), { threshold: 90 });

  // Neither marker is finalized.
  const globalLedger = JSON.parse(readFileSync(migrationLedgerPath(), "utf-8"));
  const projectLedger = JSON.parse(readFileSync(join(cwd, ".unipi", "config", "settings-version.json"), "utf-8"));
  assert.equal(globalLedger.finalized, false);
  assert.equal(projectLedger.finalized, false);
  restore(home, cwd);
});
