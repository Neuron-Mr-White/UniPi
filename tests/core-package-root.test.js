import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageRoot, getInstalledPackageVersion } from "../packages/core/utils.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "unipi-package-root-"));
  const umbrella = join(dir, "node_modules", "@pi-unipi", "unipi");
  const updater = join(dir, "node_modules", "@pi-unipi", "updater", "src");
  mkdirSync(umbrella, { recursive: true });
  mkdirSync(updater, { recursive: true });
  writeFileSync(join(umbrella, "package.json"), JSON.stringify({ name: "@pi-unipi/unipi", version: "9.8.7" }));
  writeFileSync(join(dir, "node_modules", "@pi-unipi", "updater", "package.json"), JSON.stringify({ name: "@pi-unipi/updater", version: "9.8.7" }));
  return { dir, umbrella, updater };
}

describe("core package root discovery", () => {
  it("finds sibling scoped packages from dependency package directories", () => {
    const { dir, umbrella, updater } = fixture();
    try {
      assert.equal(findPackageRoot(updater, "@pi-unipi/unipi"), umbrella);
      assert.equal(getInstalledPackageVersion(updater, "@pi-unipi/unipi"), "9.8.7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
