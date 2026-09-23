/**
 * @pi-unipi/kanboard — binary resolution + CLI bridge.
 *
 * One writer for the board is the Rust binary; this module finds it and runs
 * it. Resolution order (first hit wins):
 *   1. `UNIPI_KANBOARD_BIN` (an explicit path — tests and tinkerers)
 *   2. the platform package `@pi-unipi/kanboard-<platform>-<arch>` (K4 ships these)
 *   3. the dev build: `<repo>/crates/kanboard/target/{release,debug}/unipi-kanboard`
 *
 * Nothing is downloaded, built or guessed at runtime: when no binary is found,
 * every kanboard command reports "kanboard binary unavailable for <platform>-<arch>"
 * and does nothing else.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BinarySource = "env" | "platform-package" | "dev-build";

export interface KanboardBinary {
  path: string;
  source: BinarySource;
}

/** `<platform>-<arch>` as used by the platform packages and in messages. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function exeSuffix(platform: string = process.platform): string {
  return platform === "win32" ? ".exe" : "";
}

/** Repo root, from `packages/kanboard/src/bin.ts` → up three levels. */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function isRunnable(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function platformPackagePath(): string | null {
  const name = `@pi-unipi/kanboard-${platformKey()}`;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`${name}/package.json`);
    return join(dirname(pkg), "bin", `unipi-kanboard${exeSuffix()}`);
  } catch {
    // Not installed (K4 ships it) — fall through to the dev build.
    return null;
  }
}

function devBuildPath(): string | null {
  const root = repoRoot();
  const names = [`unipi-kanboard${exeSuffix()}`];
  for (const profile of ["release", "debug"]) {
    for (const name of names) {
      const candidate = join(root, "crates", "kanboard", "target", profile, name);
      if (isRunnable(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveBinary(env: NodeJS.ProcessEnv = process.env): KanboardBinary | null {
  const explicit = env.UNIPI_KANBOARD_BIN?.trim();
  if (explicit) {
    return isRunnable(explicit) ? { path: explicit, source: "env" } : null;
  }
  const packaged = platformPackagePath();
  if (packaged && isRunnable(packaged)) return { path: packaged, source: "platform-package" };
  const dev = devBuildPath();
  if (dev) return { path: dev, source: "dev-build" };
  return null;
}

export function unavailableMessage(platform: string = process.platform, arch: string = process.arch): string {
  return `kanboard binary unavailable for ${platform}-${arch}`;
}

/** A rule/usage error the binary reported (its message is meant to be shown). */
export class KanboardCliError extends Error {
  readonly code: number;
  readonly kind: string;

  constructor(message: string, code: number, kind: string) {
    super(message);
    this.name = "KanboardCliError";
    this.code = code;
    this.kind = kind;
  }
}

export interface RunCliOptions {
  /** Ask the binary for `--json` and parse it (default true). */
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Extra env on top of `env` (UNIPI_KANBOARD_HOME etc.). */
  extraEnv?: Record<string, string>;
}

export interface KanboardCli {
  binary: KanboardBinary;
  run<T = unknown>(args: string[], options?: RunCliOptions): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Wrap a resolved binary into a runner that parses JSON and surfaces rule messages. */
export function createCli(binary: KanboardBinary, baseEnv: NodeJS.ProcessEnv = process.env): KanboardCli {
  return {
    binary,
    run<T = unknown>(args: string[], options: RunCliOptions = {}): Promise<T> {
      const json = options.json !== false;
      const argv = json && !args.includes("--json") ? [...args, "--json"] : args;
      const childEnv: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...(options.env ?? {}),
        ...(options.extraEnv ?? {}),
        // The UI/extension acts as the user; the agent's own invocations are the
        // only ones that set actor=agent (via the skill/prompt).
        UNIPI_KANBOARD_ACTOR: (options.extraEnv?.UNIPI_KANBOARD_ACTOR ?? baseEnv.UNIPI_KANBOARD_ACTOR ?? "user"),
      };
      return new Promise<T>((resolvePromise, reject) => {
        execFile(
          binary.path,
          argv,
          {
            cwd: options.cwd,
            env: childEnv,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const out = String(stdout ?? "").trim();
            const err = String(stderr ?? "").trim();
            if (error && !out && !err) {
              reject(new KanboardCliError(`${error.message}`, 1, "io"));
              return;
            }
            const decoded = decode(stderr, stdout);
            if (error) {
              const payload = decode(err, out);
              if (payload && typeof payload === "object" && "error" in payload) {
                const detail = payload as { error?: string; kind?: string };
                reject(
                  new KanboardCliError(
                    detail.error ?? error.message,
                    (error as { code?: number }).code ?? 1,
                    detail.kind ?? "rule",
                  ),
                );
                return;
              }
              reject(new KanboardCliError(err || out || error.message, (error as { code?: number }).code ?? 1, "io"));
              return;
            }
            if (!json) {
              resolvePromise(out as unknown as T);
              return;
            }
            try {
              resolvePromise(JSON.parse(out) as T);
            } catch (parseError) {
              reject(new KanboardCliError(`unexpected output from unipi-kanboard: ${out.slice(0, 200)}`, 1, "parse"));
              return;
            }
            void decoded;
          },
        );
      });
    },
  };
}

function decode(stderr: string, stdout: string): unknown {
  for (const candidate of [stderr, stdout]) {
    const text = candidate.trim();
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text);
    } catch {
      // keep looking
    }
  }
  return null;
}

/** Resolve + wrap, or report why nothing can run. */
export function openCli(env: NodeJS.ProcessEnv = process.env): KanboardCli | { error: string } {
  const binary = resolveBinary(env);
  if (!binary) return { error: unavailableMessage() };
  return createCli(binary, env);
}
