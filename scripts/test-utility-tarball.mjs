import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const packDir = mkdtempSync(join(tmpdir(), "utility-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "utility-install-"));

try {
  const output = execFileSync(
    "npm",
    ["pack", "--workspace=@pi-unipi/utility", "--json", "--pack-destination", packDir],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const manifest = JSON.parse(output)[0];
  const tarball = join(packDir, manifest.filename);

  execFileSync("npm", ["init", "-y"], { cwd: installDir, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: installDir, stdio: "ignore" });

  const utilityRoot = join(installDir, "node_modules/@pi-unipi/utility");
  const pkg = JSON.parse(readFileSync(join(utilityRoot, "package.json"), "utf8"));
  if (!pkg.dependencies?.shiki) throw new Error("Utility does not declare direct shiki dependency");
  if (pkg.dependencies?.["@shikijs/cli"]) throw new Error("Utility still declares unused @shikijs/cli");
  if (!pkg.peerDependencies?.["@earendil-works/pi-tui"]) throw new Error("Utility does not declare Pi TUI peer");

  const requireFromUtility = createRequire(join(utilityRoot, "package.json"));
  requireFromUtility.resolve("shiki");
  requireFromUtility.resolve("@earendil-works/pi-tui");

  console.log("Utility tarball dependency resolution passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}
