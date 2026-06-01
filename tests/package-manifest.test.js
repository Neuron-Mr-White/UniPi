import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function manifestResources() {
  return [
    ...pkg.pi.extensions.map((path) => ({ type: "extension", path })),
    ...pkg.pi.skills.map((path) => ({ type: "skill", path })),
  ];
}

describe("umbrella package pi manifest", () => {
  it("split workspace packages explicitly disable Pi resource discovery", () => {
    for (const dir of readdirSync("packages")) {
      const pkgPath = `packages/${dir}/package.json`;
      if (!existsSync(pkgPath)) continue;
      const workspacePkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      assert.deepEqual(
        workspacePkg.pi,
        { extensions: [], skills: [], prompts: [], themes: [] },
        `${workspacePkg.name} must explicitly disable Pi resources so umbrella dependencies are not auto-discovered`,
      );
    }
  });

  it("does not point at hoisted node_modules resources", () => {
    for (const resource of manifestResources()) {
      assert.ok(
        !resource.path.startsWith("node_modules/@pi-unipi/"),
        `${resource.type} path ${resource.path} must be package-internal so npm hoisting cannot break it`,
      );
    }
  });

  it("ships every pi manifest resource in npm pack output", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [pack] = JSON.parse(output);
    const packedPaths = pack.files.map((file) => file.path);

    for (const resource of manifestResources()) {
      const normalized = resource.path.replace(/\/$/, "");
      const isPacked = packedPaths.some(
        (packedPath) => packedPath === normalized || packedPath.startsWith(`${normalized}/`),
      );
      assert.ok(isPacked, `${resource.type} path ${resource.path} must be included in npm pack output`);
    }
  });
});
