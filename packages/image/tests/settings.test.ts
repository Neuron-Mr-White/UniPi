/**
 * Settings tests.
 *
 * The config directory is redirected with UNIPI_IMAGE_CONFIG_DIR so the real
 * home directory is never touched.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  originalEnv = process.env.UNIPI_IMAGE_CONFIG_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-image-test-"));
  process.env.UNIPI_IMAGE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.UNIPI_IMAGE_CONFIG_DIR;
  else process.env.UNIPI_IMAGE_CONFIG_DIR = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(tmpDir, "config.json");
}

describe("loadConfig", () => {
  it("returns defaults when no config exists", async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });

  it("returns defaults for malformed JSON instead of throwing", async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    fs.writeFileSync(configPath(), "{ not json at all");
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });

  it("returns defaults when the file holds a non-object", async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    for (const body of ["[]", '"text"', "42", "null"]) {
      fs.writeFileSync(configPath(), body);
      assert.deepEqual(loadConfig(), DEFAULT_CONFIG, `failed for ${body}`);
    }
  });

  it("merges a partial config over the defaults", async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ generate: { model: "openrouter/custom/model" } }),
    );

    const config = loadConfig();
    assert.equal(config.generate.model, "openrouter/custom/model");
    // Unspecified fields keep their defaults.
    assert.equal(config.generate.enabled, DEFAULT_CONFIG.generate.enabled);
    assert.equal(config.generate.outputDir, DEFAULT_CONFIG.generate.outputDir);
    assert.deepEqual(config.recognize, DEFAULT_CONFIG.recognize);
  });

  it("ignores fields whose type does not match the default", async () => {
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        generate: { enabled: "yes", model: 42, outputDir: ["nope"] },
      }),
    );

    const config = loadConfig();
    assert.equal(config.generate.enabled, DEFAULT_CONFIG.generate.enabled);
    assert.equal(config.generate.model, DEFAULT_CONFIG.generate.model);
    assert.equal(config.generate.outputDir, DEFAULT_CONFIG.generate.outputDir);
  });

  it("accepts a false boolean rather than treating it as absent", async () => {
    const { loadConfig } = await import("../src/settings.ts");
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ generate: { enabled: false, saveToDisk: false } }),
    );

    const config = loadConfig();
    assert.equal(config.generate.enabled, false);
    assert.equal(config.generate.saveToDisk, false);
  });

  it("does not share mutable state between calls", async () => {
    const { loadConfig } = await import("../src/settings.ts");
    const first = loadConfig();
    first.generate.model = "mutated";
    assert.notEqual(loadConfig().generate.model, "mutated");
  });
});

describe("saveConfig / updateConfig", () => {
  it("round-trips a full config", async () => {
    const { loadConfig, saveConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");

    const custom = structuredClone(DEFAULT_CONFIG);
    custom.generate.model = "openrouter/black-forest-labs/flux.2-pro";
    custom.generate.saveToDisk = false;
    custom.recognize.systemPrompt = "Be terse.";

    assert.equal(saveConfig(custom), true);
    assert.deepEqual(loadConfig(), custom);
  });

  it("creates the config directory when missing", async () => {
    const { saveConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    const nested = path.join(tmpDir, "deep", "nested");
    process.env.UNIPI_IMAGE_CONFIG_DIR = nested;

    assert.equal(saveConfig(DEFAULT_CONFIG), true);
    assert.ok(fs.existsSync(path.join(nested, "config.json")));
  });

  it("merges one level deep on update", async () => {
    const { updateConfig, loadConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");

    updateConfig({ generate: { ...DEFAULT_CONFIG.generate, model: "a/b" } });
    updateConfig({ recognize: { ...DEFAULT_CONFIG.recognize, model: "c/d" } });

    const config = loadConfig();
    assert.equal(config.generate.model, "a/b", "later update must not clobber the earlier one");
    assert.equal(config.recognize.model, "c/d");
  });

  it("reports failure instead of throwing when the path is unwritable", async () => {
    const { saveConfig, DEFAULT_CONFIG } = await import("../src/settings.ts");
    // A file where the directory should be makes mkdir fail.
    const blocked = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocked, "not a directory");
    process.env.UNIPI_IMAGE_CONFIG_DIR = path.join(blocked, "sub");

    assert.equal(saveConfig(DEFAULT_CONFIG), false);
  });
});

describe("getOutputDir", () => {
  it("expands a leading ~ to the home directory", async () => {
    const { getOutputDir, DEFAULT_CONFIG } = await import("../src/settings.ts");
    const config = structuredClone(DEFAULT_CONFIG);
    config.generate.outputDir = "~/.unipi/images";

    const resolved = getOutputDir(config);
    assert.equal(resolved, path.join(os.homedir(), ".unipi", "images"));
    assert.doesNotMatch(resolved, /~/);
  });

  it("passes an absolute path through unchanged", async () => {
    const { getOutputDir, DEFAULT_CONFIG } = await import("../src/settings.ts");
    const config = structuredClone(DEFAULT_CONFIG);
    config.generate.outputDir = "/var/tmp/pics";
    assert.equal(getOutputDir(config), "/var/tmp/pics");
  });

  it("falls back to the default when the value is blank", async () => {
    const { getOutputDir, DEFAULT_CONFIG } = await import("../src/settings.ts");
    const config = structuredClone(DEFAULT_CONFIG);
    config.generate.outputDir = "   ";
    assert.equal(getOutputDir(config), path.join(os.homedir(), ".unipi", "images"));
  });
});

describe("expandHome", () => {
  it("expands a bare tilde", async () => {
    const { expandHome } = await import("../src/settings.ts");
    assert.equal(expandHome("~"), os.homedir());
  });

  it("does not expand a tilde inside a path", async () => {
    const { expandHome } = await import("../src/settings.ts");
    assert.equal(expandHome("/tmp/~backup"), "/tmp/~backup");
  });
});
