/**
 * @pi-unipi/utility — Environment info tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEnvironmentInfo, formatEnvironmentInfo } from "../src/tools/env.ts";

describe("getEnvironmentInfo", () => {
  it("returns environment data", () => {
    const info = getEnvironmentInfo();
    assert.ok("nodeVersion" in info);
    assert.ok("piVersion" in info);
    assert.ok("os" in info);
    assert.ok("platform" in info);
    assert.ok("unipiModules" in info);
    assert.ok("configPaths" in info);
    assert.ok("extensionPaths" in info);
  });

  it("has valid Node version", () => {
    const info = getEnvironmentInfo();
    assert.ok(/^v\d+/.test(info.nodeVersion));
  });

  it("has valid platform", () => {
    const info = getEnvironmentInfo();
    assert.ok(["darwin", "linux", "win32"].includes(info.platform));
  });
});

describe("formatEnvironmentInfo", () => {
  it("formats as markdown", () => {
    const info = getEnvironmentInfo();
    const markdown = formatEnvironmentInfo(info);
    assert.ok(markdown.includes("Environment"));
    assert.ok(markdown.includes(info.nodeVersion));
  });
});
