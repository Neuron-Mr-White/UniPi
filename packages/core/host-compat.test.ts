/**
 * GH #41 regression guard: the @pi-unipi/core barrel is imported by every
 * UniPi package (notify included). A static NAMED value import from
 * "@earendil-works/pi-coding-agent" hard-fails ESM linking on any host whose
 * pi surface lacks that export (OMP's legacy-pi compat module had no
 * createLocalBashOperations), taking down packages that never use it.
 *
 * Rule: inside core, value imports from pi-coding-agent must be namespace
 * imports (`import * as piAgent from ...`) resolved and feature-detected at
 * call time. `import type { ... }` is fine (erased at runtime).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = import.meta.dirname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

test("core has no static named value imports from @earendil-works/pi-coding-agent", () => {
  const offenders: string[] = [];
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']@earendil-works\/pi-coding-agent["']/g;
  for (const file of sources(ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      if (match[1]) continue; // `import type { ... }`
      const values = match[2].split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type "));
      if (values.length) offenders.push(`${relative(ROOT, file)}: ${values.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [], `use \`import * as piAgent\` + runtime feature detection instead:\n${offenders.join("\n")}`);
});
