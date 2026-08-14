import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function manifestResources() {
  return [
    ...pkg.pi.extensions.map((path) => ({ type: "extension", path })),
    ...pkg.pi.skills.map((path) => ({ type: "skill", path })),
  ];
}

describe("umbrella package pi manifest", () => {
  it("split workspace packages do not auto-discover Pi resources", () => {
    // Split packages may explicitly register package-internal extensions
    // (e.g. notify's ./index.ts), but they must NOT auto-discover skills,
    // prompts, or themes — those are owned by the umbrella manifest.
    for (const dir of readdirSync("packages")) {
      const pkgPath = `packages/${dir}/package.json`;
      if (!existsSync(pkgPath)) continue;
      const workspacePkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const pi = workspacePkg.pi ?? {};
      assert.deepEqual(
        [pi.prompts, pi.themes],
        [[], []],
        `${workspacePkg.name} must not auto-discover prompts/themes (umbrella owns those)`,
      );
      // Explicitly-listed extensions and skills must be package-internal, not hoisted.
      for (const skill of pi.skills ?? []) {
        assert.ok(
          !skill.startsWith("node_modules/"),
          `${workspacePkg.name} skill ${skill} must be package-internal`,
        );
      }
      // Any explicitly-listed extension must be package-internal, not hoisted.
      for (const ext of pi.extensions ?? []) {
        assert.ok(
          !ext.startsWith("node_modules/"),
          `${workspacePkg.name} extension ${ext} must be package-internal`,
        );
      }
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

  it("split extension modules do not dynamically register skill directories", () => {
    for (const dir of readdirSync("packages")) {
      const pkgPath = `packages/${dir}/package.json`;
      if (!existsSync(pkgPath)) continue;
      const workspacePkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const hasSkillFiles = workspacePkg.files?.some((entry) => String(entry).includes("skills"));
      const hasPiSkills = (workspacePkg.pi?.skills ?? []).length > 0;
      if (!hasSkillFiles && !hasPiSkills) continue;

      const files = ["index.ts", "src/index.ts"]
        .map((file) => join("packages", dir, file))
        .filter((file) => existsSync(file));
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        assert.ok(
          !source.includes('pi.on("resources_discover"'),
          `${file} must not return skillPaths; root @pi-unipi/unipi pi.skills is the only skill source`,
        );
      }
    }
  });

  it("ships every pi manifest resource and runtime bridge in npm pack output", () => {
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

    assert.ok(
      packedPaths.includes("packages/memory/bridge/mempalace_bridge.py"),
      "umbrella tarball must ship the MemPalace bridge used by bundled.js",
    );
  });
});
