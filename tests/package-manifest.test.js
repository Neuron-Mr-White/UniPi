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
    // Split packages declare their own package-internal extensions, skills,
    // prompts, and themes so standalone installs work (issue #29); the
    // umbrella manifest also declares them for umbrella installs. What stays
    // forbidden is hoisting (node_modules paths) and dynamic auto-discovery.
    for (const dir of readdirSync("packages")) {
      const pkgPath = `packages/${dir}/package.json`;
      if (!existsSync(pkgPath)) continue;
      const workspacePkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const pi = workspacePkg.pi ?? {};
      // Explicitly-listed resources must be package-internal, not hoisted.
      for (const mount of [
        ...(pi.extensions ?? []),
        ...(pi.skills ?? []),
        ...(pi.prompts ?? []),
        ...(pi.themes ?? []),
      ]) {
        assert.ok(
          !mount.startsWith("node_modules/"),
          `${workspacePkg.name} mount ${mount} must be package-internal`,
        );
      }
      // A package with an extension entry point must declare it — pi loads the
      // manifest literally, so an empty extensions array loads nothing on a
      // standalone install (issue #29).
      if (workspacePkg.main && pi.extensions) {
        assert.ok(
          pi.extensions.length > 0,
          `${workspacePkg.name} has main ${workspacePkg.main} but declares no pi.extensions`,
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
