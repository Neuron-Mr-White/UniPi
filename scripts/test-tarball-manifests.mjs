import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const isTest = (path) =>
  /(^|\/)(__tests__|tests)\//.test(path) || /\.(test|spec)\.[^.]+$/.test(path);

function pack(args) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(output)[0].files.map((file) => file.path);
}

const rootFiles = pack([]);
const requiredRoot = ["package.json", "packages/unipi/bundled.js"];
for (const required of requiredRoot) {
  if (!rootFiles.includes(required)) throw new Error(`Root tarball missing ${required}`);
}
const rootTests = rootFiles.filter(isTest);
if (rootTests.length) throw new Error(`Root tarball ships tests:\n${rootTests.join("\n")}`);

const packageDirs = readdirSync(resolve(root, "packages"));
for (const dir of packageDirs) {
  const packageJson = resolve(root, "packages", dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packageJson, "utf8"));
  } catch {
    continue;
  }

  const files = pack([`--workspace=${pkg.name}`]);
  const tests = files.filter(isTest);
  if (tests.length) throw new Error(`${pkg.name} ships tests:\n${tests.join("\n")}`);
  if (!files.includes("package.json") || !files.includes("README.md")) {
    throw new Error(`${pkg.name} missing package.json or README.md`);
  }
  if (pkg.main && !files.includes(pkg.main)) {
    throw new Error(`${pkg.name} tarball missing main ${pkg.main}`);
  }

  // Regression guard for issue #29: a package with an extension entry point
  // (`main`) must declare it in its pi manifest. Pi loads the manifest
  // literally — an empty `extensions` array means nothing loads on a
  // standalone install.
  if (pkg.main && pkg.pi && Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length === 0) {
    throw new Error(`${pkg.name} has main ${pkg.main} but pi.extensions is empty — standalone installs would load nothing`);
  }
  for (const mount of [...(pkg.pi?.extensions ?? []), ...(pkg.pi?.skills ?? []), ...(pkg.pi?.prompts ?? []), ...(pkg.pi?.themes ?? [])]) {
    const rel = mount.replace(/^\.\//, "");
    const hit = files.includes(rel) || files.some((f) => f.startsWith(rel + "/"));
    if (!hit) {
      throw new Error(`${pkg.name} pi manifest mounts ${mount} but it is not in the tarball`);
    }
  }
}

console.log(`Tarball manifests passed: root + ${packageDirs.length} package directories`);
