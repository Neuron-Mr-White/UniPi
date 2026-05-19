/**
 * @pi-unipi/updater — version comparison tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isNewerVersion } from "../src/version.ts";

describe("updater version comparison", () => {
  it("does not treat an older npm/cache version as an update", () => {
    assert.equal(isNewerVersion("2.0.4", "2.0.5"), false);
  });

  it("treats a newer npm/cache version as an update", () => {
    assert.equal(isNewerVersion("2.0.6", "2.0.5"), true);
  });

  it("does not treat equal versions as updates", () => {
    assert.equal(isNewerVersion("2.0.5", "2.0.5"), false);
    assert.equal(isNewerVersion("v2.0.5", "2.0.5"), false);
  });

  it("compares numeric components, not lexicographic strings", () => {
    assert.equal(compareVersions("2.0.10", "2.0.9"), 1);
    assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
    assert.equal(compareVersions("3.0.0", "2.99.99"), 1);
  });
});
