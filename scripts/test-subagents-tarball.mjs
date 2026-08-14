import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packDir = mkdtempSync(join(tmpdir(), "subagents-pack-"));
const installDir = mkdtempSync(join(tmpdir(), "subagents-install-"));

try {
  const output = execFileSync(
    "npm",
    ["pack", "--workspace=@pi-unipi/subagents", "--json", "--pack-destination", packDir],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const manifest = JSON.parse(output)[0];
  const paths = manifest.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
    if (!paths.includes(required)) throw new Error(`Subagents tarball missing ${required}`);
  }
  if (paths.some((path) => path.includes("__tests__") || path.startsWith("src/"))) {
    throw new Error("Subagents tarball contains test or raw source files");
  }

  const tarball = join(packDir, manifest.filename);
  execFileSync("npm", ["init", "-y"], { cwd: installDir, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: installDir, stdio: "ignore" });
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", "const m=await import('@pi-unipi/subagents'); if(typeof m.default!=='function') process.exit(2)"],
    { cwd: installDir, stdio: "inherit" },
  );

  const pkg = JSON.parse(readFileSync(join(installDir, "node_modules/@pi-unipi/subagents/package.json"), "utf8"));
  if (!pkg.pi?.extensions?.includes("./dist/index.js")) throw new Error("Standalone Pi extension entry missing");
  console.log(`Subagents tarball smoke test passed (${paths.length} files)`);
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}
