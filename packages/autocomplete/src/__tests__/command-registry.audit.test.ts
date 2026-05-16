import { describe, expect, it } from "vitest";
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "packages", "autocomplete", "src", "constants.ts"))) return dir;
    dir = dirname(dir);
  }
  return start;
}

const root = findRepoRoot(process.cwd());

function read(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

function collectConstants(): Map<string, string> {
  const constants = new Map<string, string>([["UNIPI_PREFIX", "unipi:"]]);

  for (const path of globSync("packages/**/*.ts", { cwd: root })) {
    const text = read(path);
    for (const obj of text.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g)) {
      const [, name, body] = obj;
      for (const item of body.matchAll(/(\w+):\s*"([^"]+)"/g)) {
        constants.set(`${name}.${item[1]}`, item[2]);
      }
    }
  }

  return constants;
}

function evaluateCommandExpression(expr: string, constants: Map<string, string>): string | null {
  const trimmed = expr.trim();

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return end > 0 ? trimmed.slice(1, end) : null;
  }

  if (trimmed.startsWith("`")) {
    const end = trimmed.lastIndexOf("`");
    if (end <= 0) return null;
    return trimmed.slice(1, end).replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const resolved = constants.get(key.trim());
      return resolved ?? `\${${key}}`;
    });
  }

  return constants.get(trimmed) ?? null;
}

function registeredCommands(): { commands: Set<string>; nonUnipi: string[]; unresolved: string[] } {
  const constants = collectConstants();
  const commands = new Set<string>();
  const nonUnipi: string[] = [];
  const unresolved: string[] = [];

  for (const path of globSync("packages/**/*.ts", { cwd: root }).sort()) {
    const text = read(path);
    if (!text.includes("registerCommand")) continue;

    for (const match of text.matchAll(/\.registerCommand\(\s*([^,\n]+)/g)) {
      const expr = match[1].trim();

      // Workflow registers a loop over WORKFLOW_COMMANDS via local `fullCommand`.
      if (path === "packages/workflow/commands.ts" && expr === "fullCommand") {
        for (const [key, value] of constants) {
          if (key.startsWith("WORKFLOW_COMMANDS.")) commands.add(`unipi:${value}`);
        }
        continue;
      }

      const command = evaluateCommandExpression(expr, constants);
      if (!command || command.includes("${")) {
        unresolved.push(`${path}: ${expr}`);
        continue;
      }

      if (command.startsWith("unipi:")) {
        commands.add(command);
      } else {
        nonUnipi.push(`${command} (${path})`);
      }
    }
  }

  return { commands, nonUnipi, unresolved };
}

function autocompleteRegistry(): { registry: Set<string>; descriptions: Set<string>; registryPackages: Set<string>; labels: Set<string> } {
  const text = read("packages/autocomplete/src/constants.ts");
  const registryBody = text.match(/export const COMMAND_REGISTRY[^=]*= \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const descriptionsBody = text.match(/export const COMMAND_DESCRIPTIONS[^=]*= \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const labelsBody = text.match(/export const PACKAGE_LABELS[^=]*= \{([\s\S]*?)\n\};/)?.[1] ?? "";

  const registry = new Set([...registryBody.matchAll(/"(unipi:[^"]+)"\s*:/g)].map((m) => m[1]));
  const descriptions = new Set([...descriptionsBody.matchAll(/"(unipi:[^"]+)"\s*:/g)].map((m) => m[1]));
  const registryPackages = new Set([...registryBody.matchAll(/"unipi:[^"]+"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
  const labels = new Set([...labelsBody.matchAll(/^\s*"?([a-z][a-z0-9-]*)"?:\s*"/gm)].map((m) => m[1]));

  return { registry, descriptions, registryPackages, labels };
}

describe("autocomplete command registry audit", () => {
  it("mirrors every registered /unipi:* command and has no non-unipi package commands", () => {
    const registered = registeredCommands();
    const autocomplete = autocompleteRegistry();

    expect(registered.unresolved, "unresolved registerCommand expressions").toEqual([]);
    expect(registered.nonUnipi, "package commands must use the unipi: prefix").toEqual([]);
    expect([...registered.commands].sort()).toEqual([...autocomplete.registry].sort());
    expect([...autocomplete.registry].sort()).toEqual([...autocomplete.descriptions].sort());
    expect([...autocomplete.registryPackages].filter((pkg) => !autocomplete.labels.has(pkg)).sort()).toEqual([]);
  });
});
