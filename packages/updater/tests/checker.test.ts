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

  it("orders prerelease identifiers by semver precedence", () => {
    assert.equal(compareVersions("3.0.0-alpha.2", "3.0.0-alpha.1"), 1);
    assert.equal(compareVersions("3.0.0-alpha.10", "3.0.0-alpha.9"), 1);
    assert.equal(compareVersions("3.0.0-beta.0", "3.0.0-alpha.7"), 1);
    assert.equal(compareVersions("3.0.0-rc.1", "3.0.0-beta.9"), 1);
  });

  it("ranks a stable release above its own prereleases (graduation)", () => {
    assert.equal(compareVersions("3.0.0", "3.0.0-alpha.0"), 1);
    assert.equal(isNewerVersion("3.0.0", "3.0.0-alpha.0"), true);
    assert.equal(isNewerVersion("3.0.0-alpha.0", "3.0.0"), false);
  });

  it("treats identical prereleases as equal", () => {
    assert.equal(compareVersions("3.0.0-alpha.0", "3.0.0-alpha.0"), 0);
    assert.equal(compareVersions("2.20.5", "2.20.5"), 0);
  });
});
