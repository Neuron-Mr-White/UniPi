import { describe, it, expect } from "bun:test";
import { migrateConfig, loadConfig, saveConfig } from "../src/config/manager.js";
import { DEFAULT_COMPACTOR_CONFIG } from "../src/config/schema.js";
import { detectPreset, applyPreset } from "../src/config/presets.js";

describe("config", () => {
  it("keeps the extra percentage compaction boundary disabled by default", () => {
    expect(DEFAULT_COMPACTOR_CONFIG.autoCompaction).toMatchObject({
      enabled: false,
      thresholdPercent: 80,
      cooldownMs: 60_000,
      repeatMinGrowthTokens: 4_000,
    });
  });

  it("migrateConfig fills missing keys", () => {
    const partial = { debug: true } as any;
    const config = migrateConfig(partial);
    expect(config.debug).toBe(true);
    expect(config.sessionGoals).toBeDefined();
    expect(config.sessionGoals.enabled).toBe(true);
    expect(config.autoCompaction).toEqual(DEFAULT_COMPACTOR_CONFIG.autoCompaction);
  });

  it("migrateConfig merges partial auto-compaction settings", () => {
    const config = migrateConfig({
      autoCompaction: { enabled: true, thresholdPercent: 85 } as any,
    });

    expect(config.autoCompaction.enabled).toBe(true);
    expect(config.autoCompaction.thresholdPercent).toBe(85);
    expect(config.autoCompaction.cooldownMs).toBe(DEFAULT_COMPACTOR_CONFIG.autoCompaction.cooldownMs);
    expect(config.autoCompaction.repeatMinGrowthTokens).toBe(DEFAULT_COMPACTOR_CONFIG.autoCompaction.repeatMinGrowthTokens);
    expect(config.autoCompaction.notify).toBe(DEFAULT_COMPACTOR_CONFIG.autoCompaction.notify);
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

  it("presets configure only the implemented pipeline feature", () => {
    const reservedDefaults = {
      ttlCache: false,
      proximityReranking: false,
      timelineSort: false,
      progressiveThrottling: false,
      mmapPragma: false,
    };

    expect(applyPreset("precise").pipeline).toMatchObject({
      ...reservedDefaults,
      autoInjection: false,
    });
    expect(applyPreset("balanced").pipeline).toMatchObject({
      ...reservedDefaults,
      autoInjection: true,
    });
    expect(applyPreset("thorough").pipeline).toEqual(applyPreset("balanced").pipeline);
    expect(applyPreset("lean").pipeline).toMatchObject({
      ...reservedDefaults,
      autoInjection: false,
    });
  });

  it("presets leave deprecated display compatibility fields at defaults", () => {
    for (const name of ["precise", "balanced", "thorough", "lean"] as const) {
      expect(applyPreset(name).toolDisplay).toEqual(DEFAULT_COMPACTOR_CONFIG.toolDisplay);
      expect(applyPreset(name).showTruncationHints).toBe(DEFAULT_COMPACTOR_CONFIG.showTruncationHints);
    }
  });

  it("new and legacy preset aliases produce matching pipeline settings", () => {
    expect(applyPreset("opencode").pipeline).toEqual(applyPreset("precise").pipeline);
    expect(applyPreset("verbose").pipeline).toEqual(applyPreset("thorough").pipeline);
    expect(applyPreset("minimal").pipeline).toEqual(applyPreset("lean").pipeline);
  });

  it("loadConfig returns defaults when no file", () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(config.overrideDefaultCompaction).toBe(true);
    expect(config.autoCompaction.enabled).toBe(false);
    expect(config.autoCompaction.thresholdPercent).toBe(80);
  });
});
