#!/usr/bin/env node
/**
 * End-to-end packaging proof (no registry, no network):
 *
 *   1. copy the musl binary into packages/kanboard-bin/linux-x64/bin/
 *   2. `npm pack` the kanboard package and the linux-x64 platform package
 *   3. lay both tarballs out as node_modules/@pi-unipi/<name> in a temp project
 *   4. resolve the binary through packages/kanboard/src/bin.ts and run --version
 *
 * Exits non-zero when any step fails, so CI (or a release) can gate on it.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const platform = "linux-x64";
const musl = join(root, "crates", "kanboard", "target", "x86_64-unknown-linux-musl", "release", "unipi-kanboard");
const debug = join(root, "crates", "kanboard", "target", "debug", "unipi-kanboard");

const source = existsSync(musl) ? musl : debug;
if (!existsSync(source)) {
  console.error(`✗ no binary to package (tried ${musl} and ${debug})`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "kb-pack-"));
const project = join(work, "project");
mkdirSync(project, { recursive: true });
console.log(`binary: ${source.replace(root + "/", "")} (${(execFileSync("stat", ["-c", "%s", source], { encoding: "utf-8" }).trim() / 1048576).toFixed(1)} MB)`);

// 1. stage the binary into the platform package
const binDir = join(root, "packages", "kanboard-bin", platform, "bin");
mkdirSync(binDir, { recursive: true });
cpSync(source, join(binDir, "unipi-kanboard"));
cpSync(join(binDir, "unipi-kanboard"), join(work, "staged-binary"));
console.log(`staged: packages/kanboard-bin/${platform}/bin/unipi-kanboard`);

// 2. pack both packages
const pack = (directory) => {
  const output = execFileSync("npm", ["pack", "--pack-destination", work, directory], {
    cwd: root,
    encoding: "utf-8",
  }).trim();
  const tarball = output.split("\n").pop().trim();
  console.log(`packed: ${tarball}`);
  return join(work, tarball);
};

const kanboardTarball = pack(join(root, "packages", "kanboard"));
const platformTarball = pack(join(root, "packages", "kanboard-bin", platform));

// 3. install layout: extract the tarballs into node_modules/@pi-unipi/<name>
const install = (tarball, name) => {
  const target = join(project, "node_modules", "@pi-unipi", name);
  mkdirSync(target, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components=1"]);
  console.log(`installed: node_modules/@pi-unipi/${name} -> ${readdirSync(target).join(", ")}`);
};
install(kanboardTarball, "kanboard");
install(platformTarball, `kanboard-${platform}`);

// the platform binary must survive packing, byte for byte
const installedBinary = join(project, "node_modules", "@pi-unipi", `kanboard-${platform}`, "bin", "unipi-kanboard");
const sameBytes =
  execFileSync("cmp", ["-s", join(work, "staged-binary"), installedBinary], { encoding: "utf-8" }) === "" &&
  execFileSync("sha256sum", [installedBinary], { encoding: "utf-8" }).split(" ")[0] ===
    execFileSync("sha256sum", [join(work, "staged-binary")], { encoding: "utf-8" }).split(" ")[0];
if (!sameBytes) {
  console.error("✗ the packed binary differs from the staged one");
  process.exit(1);
}
console.log("verified: the packed binary is byte-identical to the staged build");

// 4. resolve + run through bin.ts from the fake installed project
const probe = join(work, "probe.mts");
const { writeFileSync } = await import("node:fs");
writeFileSync(
  probe,
  `import { resolveBinary, createCli } from ${JSON.stringify(join(project, "node_modules", "@pi-unipi", "kanboard", "src", "bin.ts"))};\n` +
    `const binary = resolveBinary({}, ${JSON.stringify(join(project, "index.js"))});\n` +
    `if (!binary) { console.error("✗ resolution failed"); process.exit(1); }\n` +
    `console.log("resolved source:", binary.source);\n` +
    `console.log("resolved path:  ", binary.path.replace(${JSON.stringify(project)}, "<project>"));\n` +
    `const cli = createCli(binary);\n` +
    `const projects = await cli.run(["project", "list"]);\n` +
    `console.log("run(['project','list']) ok:", Array.isArray(projects), "entries:", projects.length);\n` +
    `const version = await cli.run(["--version"], { json: false });\n` +
    `console.log("cli --version:", String(version).trim());\n`,
);
const output = execFileSync(join(root, "node_modules", ".bin", "tsx"), [probe], { encoding: "utf-8", cwd: project });
process.stdout.write(output);

// --version through the resolved binary
const version = execFileSync(installedBinary, ["--version"], { encoding: "utf-8" }).trim();
console.log(`--version: ${version}`);

rmSync(work, { recursive: true, force: true });
console.log("\n✓ packaging proof complete");
