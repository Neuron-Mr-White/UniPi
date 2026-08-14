import { existsSync } from "node:fs";
import { resolve } from "node:path";
import * as esbuild from "esbuild";

const root = resolve(import.meta.dirname, "..");
const removed = [
  "packages/memory/search.ts",
  "packages/kanboard/tui/kanboard-overlay.ts",
  "packages/input-shortcuts/src/status.ts",
  "packages/milestone/coexist.ts",
  "packages/subagents/src/prompts.ts",
  "packages/web-api/src/tui/progress.ts",
  "packages/web-api/src/tui/result.ts",
  "packages/compactor/src/compaction/recall-scope.ts",
  "packages/compactor/src/display/bash-display.ts",
  "packages/compactor/src/display/diff-presentation.ts",
  "packages/compactor/src/display/pending-diff-preview.ts",
  "packages/compactor/src/display/user-message-box.ts",
  "packages/compactor/src/compaction/sections.ts",
  "packages/compactor/src/session/analytics.ts",
];

for (const file of removed) {
  if (existsSync(resolve(root, file))) throw new Error(`Disconnected module returned: ${file}`);
}

const onlyBundleOurs = {
  name: "externalize-third-party",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return;
      if (args.path.startsWith(".") || args.path.startsWith("/") || args.path.startsWith("@pi-unipi/")) return;
      return { path: args.path, external: true };
    });
  },
};

const result = await esbuild.build({
  entryPoints: [resolve(root, "packages/unipi/index.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  metafile: true,
  plugins: [onlyBundleOurs],
});
const inputs = Object.keys(result.metafile.inputs);
for (const file of removed) {
  if (inputs.some((input) => input.endsWith(file))) throw new Error(`Removed module is production-reachable: ${file}`);
}

console.log(`Production graph contract passed (${inputs.length} inputs, ${removed.length} retired modules)`);
