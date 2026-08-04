/**
 * Changelog path resolution.
 *
 * Regression cover for the update prompt and `/unipi:changelog` showing no
 * release notes. Both overlays resolved `CHANGELOG.md` from `process.cwd()`,
 * which only exists when pi happens to be running inside the UniPi checkout —
 * and the file was not in the published tarball at all, so for an npm user
 * there was nothing to find either way.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveChangelogPath, parseChangelog, getNewerVersions } from "../src/changelog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

test("resolves a changelog that exists", () => {
  const resolved = resolveChangelogPath();
  assert.ok(existsSync(resolved), `resolved path should exist: ${resolved}`);
  assert.match(resolved, /CHANGELOG\.md$/);
});

test("does not depend on the working directory", () => {
  // The bug: resolution from process.cwd() only worked inside the checkout.
  const original = process.cwd();
  try {
    process.chdir("/tmp");
    const resolved = resolveChangelogPath();
    assert.ok(
      existsSync(resolved),
      "must still resolve when cwd is unrelated to the install",
    );
  } finally {
    process.chdir(original);
  }
});

test("the resolved changelog parses into entries", () => {
  const entries = parseChangelog(resolveChangelogPath());
  assert.ok(entries.length > 0, "expected parsed changelog entries");
  const versioned = entries.filter((e) => /^\d+\.\d+\.\d+$/.test(e.version));
  assert.ok(versioned.length > 0, "expected at least one versioned entry");
});

test("reports versions newer than the installed one", () => {
  const entries = parseChangelog(resolveChangelogPath());

  const newer = getNewerVersions(entries, "0.0.1");
  assert.ok(newer.length > 0, "everything is newer than 0.0.1");

  // `Unreleased` is deliberately always carried through; only *versioned*
  // entries are filtered against the installed version.
  const none = getNewerVersions(entries, "999.0.0").filter(
    (e) => e.version !== "Unreleased",
  );
  assert.equal(none.length, 0, "no released version is newer than 999.0.0");

  // And it stops at the installed version rather than listing everything.
  const versions = entries
    .filter((e) => /^\d+\.\d+\.\d+$/.test(e.version))
    .map((e) => e.version);
  if (versions.length >= 2) {
    const fromSecond = getNewerVersions(entries, versions[1]).filter(
      (e) => e.version !== "Unreleased",
    );
    assert.deepEqual(fromSecond.map((e) => e.version), [versions[0]]);
  }
});

test("CHANGELOG.md is included in the published package", () => {
  // Without this the overlays have nothing to read on an npm install, no
  // matter how the path is resolved.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
    files?: string[];
  };
  assert.ok(
    (pkg.files ?? []).includes("CHANGELOG.md"),
    "root package.json files[] must ship CHANGELOG.md",
  );
});

test("no overlay resolves the changelog from the working directory", () => {
  for (const file of ["src/tui/update-overlay.ts", "src/tui/changelog-overlay.ts"]) {
    const source = readFileSync(join(HERE, "..", file), "utf-8");
    assert.doesNotMatch(
      source,
      /join\(process\.cwd\(\),\s*["']CHANGELOG\.md["']\)/,
      `${file} must use resolveChangelogPath()`,
    );
  }
});
