#!/usr/bin/env node
/**
 * Sync every @pi-unipi dependency pin across all package.json files
 * (root umbrella included) to the version given as argv[1].
 * Also sets the `version` field itself on every package, on the
 * packages/kanboard-bin/<platform> manifests, and on the [package]
 * the "version =" line of each Cargo.toml under crates/ - one run, no drift.
 * Used by the full-release chore (Step 10b).
 */
import fs from "node:fs";

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(ver)) {
  console.error(`usage: node scripts/sync-pins.mjs <version>`);
  console.error(`  version may include a prerelease suffix, e.g. 3.0.0-alpha.0`);
  process.exit(1);
}

const files = [
  "package.json",
  ...fs.readdirSync("packages").map((d) => `packages/${d}/package.json`),
  ...fs.readdirSync("packages/kanboard-bin", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `packages/kanboard-bin/${e.name}/package.json`),
];

let touched = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let changed = false;
  if (j.version && j.version !== ver) {
    j.version = ver;
    changed = true;
  }
  for (const key of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, v] of Object.entries(j[key] ?? {})) {
      // Exact pins carry the full version incl. prerelease; range pins keep
      // their operator and swap only the numeric triple + suffix.
      if (dep.startsWith("@pi-unipi/") && String(v) !== ver && !String(v).includes(`-${ver}`)) {
        j[key][dep] = String(v).replace(/[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?/, ver);
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    touched++;
    console.log(`synced: ${f} (${j.name ?? "root"})`);
  }
}
// Rust crates: only the [package] `version =` line, never deps.
const cratesRoot = "crates";
if (fs.existsSync(cratesRoot)) {
  for (const e of fs.readdirSync(cratesRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const toml = `${cratesRoot}/${e.name}/Cargo.toml`;
    if (!fs.existsSync(toml)) continue;
    const text = fs.readFileSync(toml, "utf8");
    const updated = text.replace(
      /^(\[package\][^\[]*?^version\s*=\s*")([^"]+)(")/ms,
      `$1${ver}$3`,
    );
    if (updated !== text) {
      fs.writeFileSync(toml, updated);
      touched++;
      console.log(`synced: ${toml}`);
    }
  }
}

console.log(`${touched} file(s) updated to ${ver}`);
