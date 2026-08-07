#!/usr/bin/env node
/**
 * Build the all-in-one unipi entry into a single JS file.
 *
 * jiti transpiles every .ts file on each startup (pi sets `moduleCache: false`),
 * which costs ~1s for this package's ~577 source files. Shipping a prebuilt
 * bundle cuts that to ~80ms.
 *
 * Only @pi-unipi sources and relative imports are bundled. Every third-party
 * dependency stays external and is resolved at runtime from node_modules, so
 * the output contains our code and nothing else. This matters: an earlier
 * attempt inlined node_modules wholesale, which is why bundled.js ended up
 * gitignored as potentially carrying vendored credentials.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, statSync, existsSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "packages", "unipi", "bundled.js");

/**
 * `--if-missing` is used by the postinstall hook: build only when the bundle
 * is absent, and never fail the install if esbuild is unavailable (consumers
 * installing the published tarball already have a prebuilt bundle and no
 * devDependencies).
 */
const ifMissing = process.argv.includes("--if-missing");

/** Keep everything that is not ours external. */
const onlyBundleOurs = {
  name: "externalize-third-party",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return;
      const p = args.path;
      if (p.startsWith(".") || p.startsWith("/")) return; // relative: bundle
      if (p.startsWith("@pi-unipi/")) return;             // ours: bundle
      return { path: p, external: true };
    });
  },
};

/**
 * Refuse to emit a bundle that looks like it captured a credential.
 * Cheap insurance against the failure mode that got this file gitignored.
 */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/,
  /(apiKey|api_key|secret|password)\s*[:=]\s*["'][^"']{12,}["']/,
];

async function main() {
  if (ifMissing && existsSync(outfile)) return;

  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    if (ifMissing) return; // Published installs ship the bundle already.
    throw new Error("esbuild is required to build the bundle (npm install first).");
  }

  const started = Date.now();
  await esbuild.build({
    entryPoints: [join(root, "packages", "unipi", "index.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "warning",
    plugins: [onlyBundleOurs],
  });

  const code = readFileSync(outfile, "utf-8");
  for (const pattern of SECRET_PATTERNS) {
    const hit = code.match(pattern);
    if (hit) {
      throw new Error(
        `Refusing to ship bundle: possible secret matched ${pattern} (${hit[0].slice(0, 24)}…). ` +
        `Check that third-party packages are still being externalized.`,
      );
    }
  }

  const kb = Math.round(statSync(outfile).size / 1024);
  console.log(`bundled.js  ${kb}KB  ${Date.now() - started}ms  (secret scan clean)`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  // Never break an install over a missing optional build step. `npm run build`
  // (and prepublishOnly) still surface failures via the message above.
  process.exit(ifMissing ? 0 : 1);
});
