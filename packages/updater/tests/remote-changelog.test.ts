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
