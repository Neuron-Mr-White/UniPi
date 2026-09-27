import { describe, it, expect } from "bun:test";
import { DEFAULT_COMPACTOR_CONFIG, autoCompactionOf } from "../src/config/schema.js";
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
    expect(advanced).toContain("sections.transcript");
    expect(advanced).toContain("smartKeepTail");
    expect(advanced).toContain("decisionModel.source");
    // Every field maps to a real key in the registered defaults.
    const defaults = getSettingsDefinition("compactor")!.defaults;
    for (const key of [...main, ...advanced]) {
      const value = key.split(".").reduce<any>((o, k) => o?.[k], defaults);
      expect(value).not.toBeUndefined();
    }
  });
});
