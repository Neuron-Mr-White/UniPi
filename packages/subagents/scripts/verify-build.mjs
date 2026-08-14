import { accessSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
for (const entry of ["dist/index.js", "dist/index.d.ts"]) {
  accessSync(resolve(root, entry));
}

// Build tsconfig excludes tests; fail closed if stale output survived somehow.
rmSync(resolve(root, "dist/__tests__"), { recursive: true, force: true });
