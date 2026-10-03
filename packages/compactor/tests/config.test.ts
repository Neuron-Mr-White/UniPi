import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsGates } from "@pi-unipi/core";
import { DEFAULT_COMPACTOR_CONFIG, autoCompactionOf } from "../src/config/schema.js";
import { loadConfig, migrateLegacyConfigFiles, translateLegacyConfig } from "../src/config/manager.js";
import { getSettingsDefinition } from "@pi-unipi/core";
import "../src/config/manager.js";

describe("config schema", () => {
  it("the percentage trigger is off unless When = at a percentage", () => {
    expect(autoCompactionOf(DEFAULT_COMPACTOR_CONFIG).enabled).toBe(false);
    expect(autoCompactionOf({ ...DEFAULT_COMPACTOR_CONFIG, trigger: "percent", thresholdPercent: 70 })).toMatchObject({
      enabled: true,
      thresholdPercent: 70,
      cooldownMs: 60_000,
      repeatMinGrowthTokens: 4_000,
    });
  });

  it("the settings screen shows a few main settings and hides the rest under Advanced", () => {
    const schema = getSettingsDefinition("compactor")!.schema!;
    const main = schema.filter((s) => !s.advanced).flatMap((s) => s.fields.map((f) => f.key));
    expect(main).toEqual(["method", "piCompact", "trigger", "thresholdPercent", "notify"]);
    const advanced = schema.filter((s) => s.advanced).flatMap((s) => s.fields.map((f) => f.key));
    expect(advanced).toContain("summarySections");
    expect(advanced).toContain("smartKeepTail");
    // Every field maps to a real key in the registered defaults.
    const defaults = getSettingsDefinition("compactor")!.defaults;
    for (const key of [...main, ...advanced]) {
      const value = key.split(".").reduce<any>((o, k) => o?.[k], defaults);
      expect(value).not.toBeUndefined();
    }
  });

  it("a saved method jev migrates to vcc", () => {
    expect(translateLegacyConfig({ method: "jev" }).method).toBe("vcc");
    expect(translateLegacyConfig({ method: "llm" }).method).toBe("llm");
    expect(translateLegacyConfig({ piCompact: "jev" }).piCompact).toBe("vcc");
  });
});

describe("summarySections migration (UNI-50 R1)", () => {
  const home = mkdtempSync(join(tmpdir(), "cfg-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "cfg-cwd-"));
  const configFile = join(cwd, ".unipi", "config", "compactor", "config.json");

  beforeAll(() => {
    process.env.HOME = home; // never touch the real global scope
    resetSettingsGates();
    import("../src/config/manager.js");
  });

  afterAll(() => {
    process.env.HOME = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const writeProject = (config: Record<string, unknown>) => {
    mkdirSync(join(cwd, ".unipi", "config", "compactor"), { recursive: true });
    writeFileSync(configFile, JSON.stringify(config));
  };

  it("legacy sections {files:false} derives summarySections and keeps sections in sync", () => {
    writeProject({ sections: { files: false } });
    const config = loadConfig(cwd);
    expect(config.summarySections).not.toContain("files");
    expect(config.summarySections).toContain("activeWork");
    expect(config.sections.files).toBe(false);
    expect(config.sections.activeWork).toBe(true);
  });

  it("both keys present: the new summarySections wins", () => {
    writeProject({ summarySections: ["activeWork"], sections: { files: false } });
    const config = loadConfig(cwd);
    expect(config.summarySections).toEqual(["activeWork"]);
    expect(config.sections.files).toBe(false);
    expect(config.sections.activeWork).toBe(true);
  });

  it("nothing stored: defaults apply", () => {
    rmSync(configFile, { force: true });
    const config = loadConfig(cwd);
    expect(config.summarySections).toEqual(DEFAULT_COMPACTOR_CONFIG.summarySections);
    expect(config.sections.files).toBe(true);
  });

  it("migrateLegacyConfigFiles writes the derived selection once, additively", () => {
    writeProject({ sections: { files: false } });
    migrateLegacyConfigFiles(cwd);
    const stored = JSON.parse(readFileSync(configFile, "utf8"));
    expect(stored.summarySections).not.toContain("files");
    expect(stored.sections.files).toBe(false); // legacy key untouched
    // Second run is a no-op (the layer now carries the new key).
    stored.summarySections = ["commits"];
    writeFileSync(configFile, JSON.stringify(stored));
    migrateLegacyConfigFiles(cwd);
    expect(JSON.parse(readFileSync(configFile, "utf8")).summarySections).toEqual(["commits"]);
  });
});
