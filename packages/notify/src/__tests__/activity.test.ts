/**
 * Tests for silence-after-input: per-channel filtering after a keypress.
 */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterPlatformsAfterInput,
  mergeSilenceAfterInput,
  noteInput,
  resetInputActivity,
} from "../../activity.ts";
import type { NotifyPlatform, SilenceAfterInputConfig } from "../../types.ts";

const DEFAULTS: SilenceAfterInputConfig = {
  enabled: true,
  windowMs: 10000,
  platforms: ["native"],
};

function config(partial?: Partial<SilenceAfterInputConfig>) {
  return {
    silenceAfterInput: mergeSilenceAfterInput(partial, DEFAULTS),
  };
}

const ALL: NotifyPlatform[] = ["native", "gotify", "telegram", "ntfy"];

describe("silence after input", () => {
  beforeEach(() => {
    resetInputActivity();
  });

  it("does not silence before any keypress", () => {
    const { send, silenced } = filterPlatformsAfterInput(ALL, config(), 1_000);
    assert.deepEqual(send, ALL);
    assert.deepEqual(silenced, []);
  });

  it("silences only listed platforms inside the window", () => {
    noteInput(1_000);
    const { send, silenced } = filterPlatformsAfterInput(
      ALL,
      config(),
      1_000 + 100,
    );
    assert.deepEqual(send, ["gotify", "telegram", "ntfy"]);
    assert.deepEqual(silenced, ["native"]);
  });

  it("lets every listed channel opt in independently", () => {
    noteInput(1_000);
    const { send, silenced } = filterPlatformsAfterInput(
      ALL,
      config({ platforms: ["native", "telegram"] }),
      1_000 + 100,
    );
    assert.deepEqual(send, ["gotify", "ntfy"]);
    assert.deepEqual(silenced, ["native", "telegram"]);
  });

  it("stops silencing once the window elapses", () => {
    noteInput(1_000);
    const { send, silenced } = filterPlatformsAfterInput(
      ALL,
      config(),
      1_000 + 10_000,
    );
    assert.deepEqual(send, ALL);
    assert.deepEqual(silenced, []);
  });

  it("does nothing when disabled", () => {
    noteInput(1_000);
    const { send, silenced } = filterPlatformsAfterInput(
      ALL,
      config({ enabled: false }),
      1_000 + 100,
    );
    assert.deepEqual(send, ALL);
    assert.deepEqual(silenced, []);
  });

  it("silences all enabled platforms when platforms is empty", () => {
    noteInput(1_000);
    const { send, silenced } = filterPlatformsAfterInput(
      ALL,
      config({ platforms: [] }),
      1_000 + 100,
    );
    assert.deepEqual(send, []);
    assert.deepEqual(silenced, ALL);
  });

  it("preserves an explicit empty platforms array when merging", () => {
    const merged = mergeSilenceAfterInput({ platforms: [] }, DEFAULTS);
    assert.deepEqual(merged.platforms, []);
  });

  it("uses defaults when the config key is missing", () => {
    const merged = mergeSilenceAfterInput(undefined, DEFAULTS);
    assert.deepEqual(merged, DEFAULTS);
  });

  it("keeps enabled:false and falls back invalid windowMs", () => {
    const merged = mergeSilenceAfterInput(
      { enabled: false, windowMs: -1 },
      DEFAULTS,
    );
    assert.equal(merged.enabled, false);
    assert.equal(merged.windowMs, 10000);
    assert.deepEqual(merged.platforms, ["native"]);
  });

  it("drops unknown platform names when merging", () => {
    const merged = mergeSilenceAfterInput(
      { platforms: ["native", "pagerduty", "ntfy"] as NotifyPlatform[] },
      DEFAULTS,
    );
    assert.deepEqual(merged.platforms, ["native", "ntfy"]);
  });
});
