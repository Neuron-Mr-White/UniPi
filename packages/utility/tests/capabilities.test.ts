/**
 * @pi-unipi/utility — Capabilities tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectCapabilities,
  refreshCapabilities,
  hasCapability,
  getIcon,
} from "../src/display/capabilities.ts";

describe("detectCapabilities", () => {
  it("returns a capabilities object", () => {
    const caps = detectCapabilities();
    assert.ok("color" in caps);
    assert.ok("truecolor" in caps);
    assert.ok("nerdFont" in caps);
    assert.ok("unicode" in caps);
    assert.ok("width" in caps);
    assert.ok("height" in caps);
  });

  it("returns reasonable defaults", () => {
    const caps = detectCapabilities();
    assert.equal(typeof caps.color, "boolean");
    assert.equal(typeof caps.truecolor, "boolean");
    assert.equal(typeof caps.nerdFont, "boolean");
    assert.ok(["none", "basic", "full"].includes(caps.unicode));
    assert.ok(caps.width > 0);
    assert.ok(caps.height > 0);
  });
});

describe("refreshCapabilities", () => {
  it("returns fresh capabilities", () => {
    const caps = refreshCapabilities();
    assert.ok("color" in caps);
  });
});

describe("hasCapability", () => {
  it("returns boolean for all capabilities", () => {
    assert.equal(typeof hasCapability("color"), "boolean");
    assert.equal(typeof hasCapability("nerdFont"), "boolean");
  });
});

describe("getIcon", () => {
  it("returns nerd font icon when available", () => {
    const icon = getIcon("󰘳", "[OK]");
    assert.equal(typeof icon, "string");
  });
});
