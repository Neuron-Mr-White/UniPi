import { describe, it, expect } from "bun:test";
import { migrateConfig, loadConfig, saveConfig } from "../src/config/manager.js";
import { DEFAULT_COMPACTOR_CONFIG } from "../src/config/schema.js";
import { detectPreset, applyPreset } from "../src/config/presets.js";

describe("config", () => {
  it("migrateConfig fills missing keys", () => {
    const partial = { debug: true } as any;
    const config = migrateConfig(partial);
    expect(config.debug).toBe(true);
    expect(config.sessionGoals).toBeDefined();
    expect(config.sessionGoals.enabled).toBe(true);
  });

  it("detectPreset returns custom for modified config", () => {
    const config = { ...DEFAULT_COMPACTOR_CONFIG, debug: true };
    const preset = detectPreset(config);
    expect(preset).toBe("custom");
  });

  it("applyPreset returns valid config", () => {
    const config = applyPreset("minimal");
    expect(config.commits.enabled).toBe(false);
    expect(config.briefTranscript.mode).toBe("minimal");
  });

  it("loadConfig returns defaults when no file", () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.overrideDefaultCompaction).toBe(false);
  });
});
