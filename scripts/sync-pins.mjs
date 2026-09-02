#!/usr/bin/env node
/**
 * Sync every @pi-unipi dependency pin across all package.json files
 * (root umbrella included) to the version given as argv[1].
 * Used by the full-release chore (Step 10b).
 */
import fs from "node:fs";

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+$/.test(ver)) {
  console.error(`usage: node scripts/sync-pins.mjs <version>`);
  process.exit(1);
}

const files = [
  "package.json",
  ...fs.readdirSync("packages").map((d) => `packages/${d}/package.json`),
];

let touched = 0;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  let changed = false;
  for (const key of ["dependencies", "peerDependencies"]) {
    for (const [dep, v] of Object.entries(j[key] ?? {})) {
      if (dep.startsWith("@pi-unipi/") && !String(v).includes(ver)) {
        j[key][dep] = String(v).replace(/[0-9]+\.[0-9]+\.[0-9]+/, ver);
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
console.log(`${touched} file(s) updated to @pi-unipi/*@${ver}`);
