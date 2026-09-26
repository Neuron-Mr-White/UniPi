/**
 * @pi-unipi/subagents — Child pi process spawn command resolution
 *
 * Ported from pi-subagents src/runs/shared/pi-spawn.ts. Env override uses OUR
 * prefix: UNIPI_SUBAGENT_PI_BINARY.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const UNIPI_SUBAGENT_PI_BINARY_ENV = "UNIPI_SUBAGENT_PI_BINARY";

export function findPiPackageRootFromEntry(entryPoint: string): string | undefined {
  let dir = path.dirname(entryPoint);
  while (dir !== path.dirname(dir)) {
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
      if (pkg.name === PI_CODING_AGENT_PACKAGE) return dir;
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

export function resolveInstalledPiPackageRoot(): string | undefined {
  return findPiPackageRootFromEntry(fileURLToPath(import.meta.resolve(PI_CODING_AGENT_PACKAGE)));
}

export function resolvePiPackageRoot(): string | undefined {
  try {
    const entry = process.argv[1];
    return entry ? findPiPackageRootFromEntry(fs.realpathSync(entry)) : undefined;
  } catch {
    return undefined;
  }
}

export interface PiSpawnDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv1?: string;
  existsSync?: (filePath: string) => boolean;
  realpathSync?: (filePath: string) => string;
  readFileSync?: (filePath: string, encoding: "utf8") => string;
  resolvePackageJson?: () => string;
  resolvePackageEntry?: () => string;
  piPackageRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PiSpawnCommand {
  command: string;
  args: string[];
}

function isRunnableNodeScript(
  filePath: string,
  existsSync: (filePath: string) => boolean,
): boolean {
  if (!existsSync(filePath)) return false;
  return /\.(?:mjs|cjs|js)$/i.test(filePath);
}

function normalizePath(filePath: string): string {
  return path.isAbsolute(filePath) ? path.resolve(filePath) : filePath;
}

function isStandalonePiExecutable(execPath: string): boolean {
  const executableName = execPath.split(/[\\/]/).pop();
  return /^pi(?:\.exe)?$/i.test(executableName ?? "");
}

export function resolvePiCliScript(deps: PiSpawnDeps = {}): string | undefined {
  const existsSync = deps.existsSync ?? fs.existsSync;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const readFileSync =
    deps.readFileSync ?? ((filePath: string, encoding: "utf8") => fs.readFileSync(filePath, encoding));
  const argv1 = deps.argv1 ?? process.argv[1];

  if (argv1) {
    const argvPath = normalizePath(argv1);
    if (isRunnableNodeScript(argvPath, existsSync)) {
      try {
        const canonicalArgvPath = realpathSync(argvPath);
        if (isRunnableNodeScript(canonicalArgvPath, existsSync) && findPiPackageRootFromEntry(canonicalArgvPath)) {
          return canonicalArgvPath;
        }
      } catch {
        // Host package metadata is untrusted here; keep resolving the installed Pi CLI.
      }
    }
  }

  try {
    const resolvePackageJson =
      deps.resolvePackageJson ??
      (() => {
        const root = deps.piPackageRoot ?? resolvePiPackageRoot();
        if (root) return path.join(root, "package.json");
        const packageRoot = deps.resolvePackageEntry
          ? findPiPackageRootFromEntry(deps.resolvePackageEntry())
          : resolveInstalledPiPackageRoot();
        if (!packageRoot) {
          throw new Error(`Could not resolve ${PI_CODING_AGENT_PACKAGE} package root`);
        }
        return path.join(packageRoot, "package.json");
      });
    const packageJsonPath = resolvePackageJson();
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binField = packageJson.bin;
    const binPath = typeof binField === "string" ? binField : (binField?.pi ?? Object.values(binField ?? {})[0]);
    if (!binPath) return undefined;
    const candidate = path.resolve(path.dirname(packageJsonPath), binPath);
    if (isRunnableNodeScript(candidate, existsSync)) {
      return candidate;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function getPiSpawnCommand(args: string[], deps: PiSpawnDeps = {}): PiSpawnCommand {
  const env = deps.env ?? process.env;
  const piBinary = env[UNIPI_SUBAGENT_PI_BINARY_ENV]?.trim();
  if (piBinary) {
    return { command: piBinary, args };
  }

  const execPath = deps.execPath ?? process.execPath;
  if (isStandalonePiExecutable(execPath)) {
    return { command: execPath, args };
  }

  const piCliPath = resolvePiCliScript(deps);
  if (piCliPath) {
    return { command: execPath, args: [piCliPath, ...args] };
  }

  return { command: "pi", args };
}
