import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Engine-backed provider auth (settings-hub round 3): keys live in the engine
// namespace providers.<id>.apiKey; legacy auth.json imports once.
let home: string;
const REAL_HOME = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "webapi-auth-"));
  process.env.HOME = home;
  void import("@pi-unipi/core").then((c) => c.resetSettingsGates());
});

afterEach(() => {
  process.env.HOME = REAL_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("web-api engine auth", () => {
  it("imports legacy auth.json once, then round-trips through the engine", async () => {
    const { resetSettingsGates } = await import("@pi-unipi/core");
    resetSettingsGates();
    const { loadAuth, setApiKey, getApiKey, removeApiKey } = await import("../src/settings.js");

    // Seed legacy auth.json
    const dir = join(home, ".unipi", "config", "web-api");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tavily: "tv-1", serpapi: "sp-2" }));

    assert.deepEqual(loadAuth(), { tavily: "tv-1", serpapi: "sp-2" }, "legacy imported");
    // Imported into the engine file now
    const cfg = JSON.parse(readFileSync(join(home, ".unipi", "config", "web-api", "config.json"), "utf8"));
    assert.equal(cfg.providers.tavily.apiKey, "tv-1", "keys land in the engine namespace");

    setApiKey("firecrawl", "fc-3");
    assert.equal(getApiKey("firecrawl"), "fc-3", "round-trip through the engine");

    removeApiKey("tavily");
    assert.equal(getApiKey("tavily"), undefined, "cleared keys read as unset");
  });
});
