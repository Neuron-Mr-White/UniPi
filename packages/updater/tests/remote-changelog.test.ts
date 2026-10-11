import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHANGELOG_RAW_BASE, fetchRemoteChangelog, loadUpdateChangelog } from "../src/remote-changelog.js";
import { getNewerVersions, parseChangelogContent } from "../src/changelog.js";

const body = "## [2.17.1] — 2026-09-15\n\n### Fixed\n- remote fix\n";

test("fetches and caches a tagged remote changelog", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "updater-changelog-"));
  let calls = 0;
  const fetchImpl = async (url: string) => {
    calls++;
    assert.equal(url, `${CHANGELOG_RAW_BASE}/v2.17.1/CHANGELOG.md`);
    return new Response(body, { status: 200 });
  };
  assert.equal(await fetchRemoteChangelog("2.17.1", { cacheDir, fetchImpl }), body);
  assert.equal(existsSync(join(cacheDir, "changelog-2.17.1.md")), true);
  assert.equal(await fetchRemoteChangelog("2.17.1", { cacheDir, fetchImpl }), body);
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(cacheDir, "changelog-2.17.1.md"), "utf8"), body);
});

test("falls back to main when the release tag is missing", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "updater-changelog-"));
  const urls: string[] = [];
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return url.includes("/v2.17.1/") ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
  };
  assert.equal(await fetchRemoteChangelog("2.17.1", { cacheDir, fetchImpl }), body);
  assert.deepEqual(urls, [
    `${CHANGELOG_RAW_BASE}/v2.17.1/CHANGELOG.md`,
    `${CHANGELOG_RAW_BASE}/main/CHANGELOG.md`,
  ]);
});

test("returns null when the remote fetch throws", async () => {
  const fetchImpl = async () => {
    throw new Error("offline");
  };
  assert.equal(await fetchRemoteChangelog("2.17.1", { cacheDir: mkdtempSync(join(tmpdir(), "updater-changelog-")), fetchImpl }), null);
});

test("loads newer remote entries and drops an empty Unreleased entry", async () => {
  const remote = "## [Unreleased]\n\n## [2.17.1] — 2026-09-15\n\n### Fixed\n- x\n\n## [2.16.1] — 2026-09-01\n\n### Fixed\n- old\n";
  const entries = await loadUpdateChangelog("2.16.1", "2.17.1", {
    cacheDir: mkdtempSync(join(tmpdir(), "updater-changelog-")),
    fetchImpl: async () => new Response(remote, { status: 200 }),
  });
  assert.deepEqual(entries.map((entry) => entry.version), ["2.17.1"]);
});

test("keeps non-empty Unreleased and drops empty Unreleased", () => {
  const entries = parseChangelogContent("## [Unreleased]\n\n## [2.17.1]\n\n### Fixed\n- x\n");
  const newer = getNewerVersions(entries, "2.16.1");
  assert.deepEqual(newer.map((entry) => entry.version), ["2.17.1"]);
  const withNotes = parseChangelogContent("## [Unreleased]\n\n### Fixed\n- pending\n\n## [2.17.1]\n\n### Fixed\n- x\n");
  assert.deepEqual(getNewerVersions(withNotes, "2.16.1").map((entry) => entry.version), ["Unreleased", "2.17.1"]);
});

test("prerelease falls back to its channel branch before main (UNI-262)", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "updater-changelog-"));
  const urls: string[] = [];
  const alphaBody = "## [3.0.0-alpha.37] — 2026-10-12\n\n### Fixed\n- alpha fix\n\n## [3.0.0-alpha.36] — 2026-10-11\n\n### Fixed\n- old\n";
  const fetchImpl = async (url: string) => {
    urls.push(url);
    return url.includes("/v3.0.0-alpha/") ? new Response(alphaBody, { status: 200 }) : new Response("", { status: 404 });
  };
  const entries = await loadUpdateChangelog("3.0.0-alpha.36", "3.0.0-alpha.37", { cacheDir, fetchImpl });
  assert.deepEqual(entries.map((e) => e.version), ["3.0.0-alpha.37"]);
  assert.deepEqual(urls, [
    `${CHANGELOG_RAW_BASE}/v3.0.0-alpha.37/CHANGELOG.md`,
    `${CHANGELOG_RAW_BASE}/v3.0.0-alpha/CHANGELOG.md`,
  ]);
  assert.equal(existsSync(join(cacheDir, "changelog-3.0.0-alpha.37.md")), false);
});

test("an alpha install never gets 2.x entries as 'newer'", async () => {
  const mainBody = "## [2.20.5] — 2026-09-30\n\n### Fixed\n- stable\n";
  const entries = await loadUpdateChangelog("3.0.0-alpha.36", "3.0.0-alpha.37", {
    cacheDir: mkdtempSync(join(tmpdir(), "updater-changelog-")),
    fetchImpl: async (url: string) => (url.includes("/main/") ? new Response(mainBody, { status: 200 }) : new Response("", { status: 404 })),
  });
  assert.equal(entries.some((e) => e.version.startsWith("2.")), false);
});

test("entries newer than the offered version are not shown", async () => {
  const body = "## [3.0.0-alpha.38]\n\n### Added\n- future\n\n## [3.0.0-alpha.37]\n\n### Fixed\n- now\n\n## [3.0.0-alpha.36]\n\n### Fixed\n- old\n";
  const entries = await loadUpdateChangelog("3.0.0-alpha.36", "3.0.0-alpha.37", {
    cacheDir: mkdtempSync(join(tmpdir(), "updater-changelog-")),
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  assert.deepEqual(entries.map((e) => e.version), ["3.0.0-alpha.37"]);
});
