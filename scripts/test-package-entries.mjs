import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = ["autocomplete", "footer", "image", "input-shortcuts", "mcp", "updater", "utility"];
const barrels = new Set(["footer", "updater"]);

for (const name of packages) {
  const dir = resolve(root, "packages", name);
  const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  if (!pkg.main || !existsSync(resolve(dir, pkg.main))) {
    throw new Error(`${name}: package main does not exist: ${pkg.main ?? "<missing>"}`);
  }

  const wrapperExists = existsSync(resolve(dir, "index.ts"));
  if (barrels.has(name)) {
    if (pkg.main !== "index.ts" || !wrapperExists) {
      throw new Error(`${name}: meaningful public barrel must be canonical`);
    }
  } else if (wrapperExists) {
    throw new Error(`${name}: disconnected default-only wrapper still exists`);
  }
}

console.log("Package entry contracts passed");
