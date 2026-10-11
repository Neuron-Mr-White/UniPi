/**
 * UNI-262 — the updater follows the install's release channel and never
 * offers a downgrade (alpha.36 install was offered 2.20.5 from `latest`).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  channelFromSpec,
  prereleaseChannel,
  resolveChannel,
  pickChannelVersion,
  installSpec,
  readUnipiPackageSpec,
} from "../src/channel.ts";

describe("channel resolution", () => {
  it("reads the prerelease id", () => {
    assert.equal(prereleaseChannel("3.0.0-alpha.36"), "alpha");
    assert.equal(prereleaseChannel("3.1.0-beta.2"), "beta");
    assert.equal(prereleaseChannel("v3.0.0-rc.1"), "rc");
    assert.equal(prereleaseChannel("2.20.5"), null);
    assert.equal(prereleaseChannel("1.0.0-0"), null);
  });

  it("reads a dist-tag from the pi package spec", () => {
    assert.equal(channelFromSpec("npm:@pi-unipi/unipi@alpha"), "alpha");
    assert.equal(channelFromSpec("@pi-unipi/unipi@next"), "next");
    assert.equal(channelFromSpec("npm:@pi-unipi/unipi"), null);
    assert.equal(channelFromSpec("npm:@pi-unipi/unipi@3.0.0-alpha.36"), null);
    assert.equal(channelFromSpec("npm:@pi-unipi/unipi@^3.0.0"), null);
    assert.equal(channelFromSpec("npm:@pi-unipi/core@alpha"), null);
  });

  it("spec tag wins, then prerelease id, then latest", () => {
    assert.equal(resolveChannel("3.0.0-alpha.36", "npm:@pi-unipi/unipi@alpha"), "alpha");
    assert.equal(resolveChannel("3.0.0-alpha.36", "npm:@pi-unipi/unipi"), "alpha");
    assert.equal(resolveChannel("3.0.0-alpha.36", null), "alpha");
    assert.equal(resolveChannel("2.20.5", null), "latest");
    assert.equal(resolveChannel("2.20.5", "npm:@pi-unipi/unipi@alpha"), "alpha");
  });

  it("never picks a lower version than the channel's own tag; offers graduation", () => {
    const tags = { latest: "2.20.5", alpha: "3.0.0-alpha.36" };
    assert.equal(pickChannelVersion(tags, "alpha"), "3.0.0-alpha.36");
    assert.equal(pickChannelVersion(tags, "latest"), "2.20.5");
    assert.equal(pickChannelVersion({ latest: "3.0.0", alpha: "3.0.0-alpha.40" }, "alpha"), "3.0.0");
    assert.equal(pickChannelVersion({ latest: "2.20.5" }, "alpha"), "2.20.5");
    assert.equal(pickChannelVersion({}, "alpha"), null);
    assert.equal(pickChannelVersion(undefined, "alpha"), null);
  });

  it("install spec keeps the channel", () => {
    assert.equal(installSpec("alpha"), "npm:@pi-unipi/unipi@alpha");
    assert.equal(installSpec("latest"), "npm:@pi-unipi/unipi");
  });

  it("reads the unipi spec from pi settings (project before global)", () => {
    const root = mkdtempSync(join(tmpdir(), "uni262-spec-"));
    try {
      const agent = join(root, "agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:other", { source: "npm:@pi-unipi/unipi@alpha" }] }));
      const cwd = join(root, "proj");
      mkdirSync(cwd);
      assert.equal(readUnipiPackageSpec(cwd, { PI_CODING_AGENT_DIR: agent }), "npm:@pi-unipi/unipi@alpha");
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@pi-unipi/unipi@beta"] }));
      assert.equal(readUnipiPackageSpec(cwd, { PI_CODING_AGENT_DIR: agent }), "npm:@pi-unipi/unipi@beta");
      assert.equal(readUnipiPackageSpec(join(root, "none"), { PI_CODING_AGENT_DIR: join(root, "nope") }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkForUpdates on a channel (fake registry)", () => {
  let home: string;
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  let checkForUpdates: typeof import("../src/checker.ts").checkForUpdates;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "uni262-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    ({ checkForUpdates } = await import("../src/checker.ts"));
  });
  after(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedProfile;
    rmSync(home, { recursive: true, force: true });
  });

  const registry = (tags: Record<string, string>) => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(tags), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  };

  it("alpha.36 install: no update when alpha is alpha.36 and latest is 2.20.5", async () => {
    const { fetchImpl, urls } = registry({ latest: "2.20.5", alpha: "3.0.0-alpha.36" });
    const r = await checkForUpdates({ fetchImpl, currentVersion: "3.0.0-alpha.36", channel: "alpha", force: true });
    assert.equal(r.updateAvailable, false);
    assert.equal(r.latestVersion, "3.0.0-alpha.36");
    assert.equal(r.channel, "alpha");
    assert.match(urls[0]!, /\/-\/package\/@pi-unipi\/unipi\/dist-tags$/);
  });

  it("alpha.36 install: alpha.37 on the alpha tag is offered", async () => {
    const { fetchImpl } = registry({ latest: "2.20.5", alpha: "3.0.0-alpha.37" });
    const r = await checkForUpdates({ fetchImpl, currentVersion: "3.0.0-alpha.36", channel: "alpha", force: true });
    assert.equal(r.updateAvailable, true);
    assert.equal(r.latestVersion, "3.0.0-alpha.37");
  });

  it("an old `latest` cache never offers 2.20.5 to an alpha install", async () => {
    const dir = join(home, ".unipi", "cache", "updater");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last-check.json"), JSON.stringify({ lastCheck: new Date().toISOString(), latestVersion: "2.20.5" }));
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const r = await checkForUpdates({ fetchImpl: failing, currentVersion: "3.0.0-alpha.36", channel: "alpha" });
    assert.equal(r.updateAvailable, false);
    assert.equal(r.latestVersion, "");
    assert.equal(r.error, "offline");
  });

  it("accepts a full packument body too", async () => {
    const { fetchImpl } = registry({ "dist-tags": { latest: "2.20.5", alpha: "3.0.0-alpha.38" } } as unknown as Record<string, string>);
    const r = await checkForUpdates({ fetchImpl, currentVersion: "3.0.0-alpha.36", channel: "alpha", force: true });
    assert.equal(r.latestVersion, "3.0.0-alpha.38");
    assert.equal(r.updateAvailable, true);
  });

  it("stable install still follows latest", async () => {
    const { fetchImpl } = registry({ latest: "2.20.6", alpha: "3.0.0-alpha.37" });
    const r = await checkForUpdates({ fetchImpl, currentVersion: "2.20.5", channel: "latest", force: true });
    assert.equal(r.latestVersion, "2.20.6");
    assert.equal(r.updateAvailable, true);
  });
});
