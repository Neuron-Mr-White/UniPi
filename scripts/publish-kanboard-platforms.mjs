#!/usr/bin/env node
/**
 * Publish the kanboard platform packages (packages/kanboard-bin/<platform>).
 *
 * Each package ships exactly one binary in `bin/`, built by
 * .github/workflows/kanboard-binaries.yml and git-ignored. A package whose
 * binary is missing is SKIPPED with a loud warning — publishing an empty
 * platform package would install a broken board for that platform.
 *
 * Usage:
 *   node scripts/publish-kanboard-platforms.mjs --dry-run
 *   node scripts/publish-kanboard-platforms.mjs                 # all platforms
 *   node scripts/publish-kanboard-platforms.mjs linux-x64 …      # named ones
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const binRoot = join(root, "packages", "kanboard-bin");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wanted = args.filter((arg) => !arg.startsWith("--"));

if (!existsSync(binRoot)) {
  console.error(`✗ no platform packages at ${binRoot}`);
  process.exit(1);
}

const platforms = readdirSync(binRoot).filter((entry) => {
  const manifest = join(binRoot, entry, "package.json");
  if (!existsSync(manifest)) return false;
  return wanted.length === 0 || wanted.includes(entry);
});

if (platforms.length === 0) {
  console.error(`✗ nothing to do (wanted: ${wanted.join(", ") || "all"})`);
  process.exit(1);
}

let published = 0;
let skipped = 0;

for (const slug of platforms.sort()) {
  const directory = join(binRoot, slug);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"));
  const windows = manifest.os?.includes("win32");
  const binary = join(directory, "bin", `unipi-kanboard${windows ? ".exe" : ""}`);
  const size = existsSync(binary) ? statSync(binary).size : 0;

  if (size === 0) {
    console.warn(
      `⚠ SKIPPING ${manifest.name}@${manifest.version}: ${binary.replace(root + "/", "")} is missing or empty.\n` +
        `  Build it first (see .github/workflows/kanboard-binaries.yml) — never publish an empty platform package.`,
    );
    skipped += 1;
    continue;
  }

  console.log(`→ ${manifest.name}@${manifest.version} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  if (dryRun) continue;
  execFileSync("npm", ["publish", "--access", "public"], { cwd: directory, stdio: "inherit" });
  published += 1;
}

console.log(
  `\n${dryRun ? "[dry-run] " : ""}published ${published}, skipped ${skipped} of ${platforms.length} platform package(s)`,
);
if (skipped > 0) {
  console.warn("⚠ skipped platforms will not be installable until their binaries are built");
}
process.exit(skipped > 0 ? 2 : 0);
