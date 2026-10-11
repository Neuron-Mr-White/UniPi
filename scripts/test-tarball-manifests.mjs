import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

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

  // Every relative import in a shipped source file must resolve to a file in
  // the SAME tarball. A file left out of `files` (memory's save-session.ts,
  // ask-user's questions.ts) passes every repo test and only breaks a real
  // install that loads the package on its own (dream's child pi -e <memory>).
  const shipped = new Set(files);
  const missing = [];
  for (const file of files) {
    if (!/\.(ts|mts|js|mjs)$/.test(file) || file.endsWith(".d.ts") || isTest(file)) continue;
    const src = readFileSync(resolve(root, "packages", dir, file), "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2];
      const base = posix.normalize(posix.join(posix.dirname(file), spec));
      const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}/index.ts`, `${base}.js`, `${base}/index.js`];
      if (!candidates.some((c) => shipped.has(c))) missing.push(`${file} → ${spec}`);
    }
  }
  if (missing.length) throw new Error(`${pkg.name} tarball imports files it does not ship:\n${missing.join("\n")}`);
}

console.log(`Tarball manifests passed: root + ${packageDirs.length} package directories`);
