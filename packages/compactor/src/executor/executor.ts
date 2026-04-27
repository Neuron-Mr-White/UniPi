/**
 * PolyglotExecutor — sandboxed code execution for 11 languages
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { detectRuntimes, buildCommand, type RuntimeMap, type Language } from "./runtime.js";
import type { ExecResult } from "../types.js";

const isWin = process.platform === "win32";

const OS_TMPDIR = (() => {
  if (isWin) return process.env.TEMP ?? process.env.TMP ?? tmpdir();
  try {
    const result = execFileSync(
      process.platform === "darwin" ? "getconf" : "mktemp",
      process.platform === "darwin" ? ["DARWIN_USER_TEMP_DIR"] : ["-u", "-d"],
      { env: { ...process.env, TMPDIR: undefined as unknown as string }, encoding: "utf-8" },
    ).trim();
    const dir = process.platform === "darwin" ? result : resolve(result, "..");
    if (dir && dir !== process.cwd()) return dir;
  } catch { /* fall through */ }
  return "/tmp";
})();

function killTree(proc: ReturnType<typeof spawn>): void {
  if (isWin && proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: "pipe" });
    } catch { /* already dead */ }
  } else if (proc.pid) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

const DANGEROUS_ENV_VARS = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID",
  "GCP_SERVICE_ACCOUNT_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN",
  "DOCKER_AUTH_CONFIG", "KUBECONFIG",
  "NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_AUTH_TOKEN",
  "PYPI_TOKEN", "POETRY_PYPI_TOKEN_PYPI",
  "SSH_PRIVATE_KEY", "SSH_AUTH_SOCK",
  "DATABASE_URL", "REDIS_URL", "MONGO_URL",
  "SECRET_KEY", "JWT_SECRET", "API_KEY", "API_SECRET",
  "PASSWORD", "PASSPHRASE", "TOKEN", "CREDENTIALS",
];

function sanitizeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of DANGEROUS_ENV_VARS) {
    delete env[key];
  }
  // Also strip anything matching *SECRET*, *PASSWORD*, *TOKEN*, *KEY*
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.includes("SECRET") || upper.includes("PASSWORD") || upper.includes("TOKEN") || upper.includes("PRIVATE_KEY")) {
      delete env[key];
    }
  }
  return env;
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  background?: boolean;
}

interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

export class PolyglotExecutor {
  #hardCapBytes: number;
  #projectRoot: string;
  #runtimes: RuntimeMap;
  #backgroundedPids = new Set<number>();

  constructor(opts?: { hardCapBytes?: number; projectRoot?: string; runtimes?: RuntimeMap }) {
    this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024;
    this.#projectRoot = opts?.projectRoot ?? process.cwd();
    this.#runtimes = opts?.runtimes ?? detectRuntimes();
  }

  get runtimes(): RuntimeMap {
    return { ...this.#runtimes };
  }

  cleanupBackgrounded(): void {
    for (const pid of this.#backgroundedPids) {
      try {
        process.kill(isWin ? pid : -pid, "SIGTERM");
      } catch { /* already dead */ }
    }
    this.#backgroundedPids.clear();
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout = 30_000, background = false } = opts;
    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".compactor-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language);
      const cmd = buildCommand(this.#runtimes, language, filePath);

      if (cmd[0] === "__rust_compile_run__") {
        return await this.#compileAndRun(filePath, tmpDir, timeout);
      }

      const cwd = language === "shell" ? this.#projectRoot : tmpDir;
      const result = await this.#spawn(cmd, cwd, tmpDir, timeout, background);

      if (!result.backgrounded) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      return result;
    } catch (err: any) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return {
        stdout: "",
        stderr: err?.message ?? String(err),
        exitCode: 1,
        timedOut: false,
      };
    }
  }

  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { language, path, timeout = 30_000, background = false } = opts;
    const cmd = buildCommand(this.#runtimes, language, path);
    const cwd = language === "shell" ? this.#projectRoot : resolve(path, "..");
    return this.#spawn(cmd, cwd, "", timeout, background);
  }

  #writeScript(tmpDir: string, code: string, language: Language): string {
    const extensions: Record<Language, string> = {
      javascript: "js", typescript: "ts", python: "py", shell: "sh",
      ruby: "rb", go: "go", rust: "rs", php: "php", perl: "pl", r: "r", elixir: "ex",
    };
    const ext = extensions[language];
    const filePath = join(tmpDir, `script.${ext}`);
    writeFileSync(filePath, code, "utf-8");
    return filePath;
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    tmpDir: string,
    timeout: number,
    background: boolean,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        cwd,
        env: sanitizeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: !isWin,
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      let stdoutLen = 0;
      let stderrLen = 0;

      const killIfOversized = () => {
        if (stdoutLen + stderrLen > this.#hardCapBytes && !killed) {
          killed = true;
          killTree(proc);
        }
      };

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        stdoutLen += chunk.length;
        killIfOversized();
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
        stderrLen += chunk.length;
        killIfOversized();
      });

      const timer = background ? null : setTimeout(() => {
        if (!killed) {
          killed = true;
          killTree(proc);
        }
      }, timeout);

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: 1, timedOut: false });
      });

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (background && proc.pid) {
          this.#backgroundedPids.add(proc.pid);
        }
        resolve({
          stdout: stdout.slice(0, this.#hardCapBytes),
          stderr: stderr.slice(0, this.#hardCapBytes),
          exitCode: code ?? 0,
          timedOut: killed && !background,
          backgrounded: background && !!proc.pid,
        });
      });
    });
  }

  async #compileAndRun(filePath: string, tmpDir: string, timeout: number): Promise<ExecResult> {
    const binPath = join(tmpDir, "script");
    try {
      execSync(`rustc "${filePath}" -o "${binPath}"`, {
        cwd: tmpDir,
        env: sanitizeEnv(),
        timeout: timeout / 2,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      return {
        stdout: "",
        stderr: err?.stderr?.toString?.() ?? err?.message ?? "Rust compilation failed",
        exitCode: 1,
        timedOut: false,
      };
    }

    return this.#spawn([binPath], tmpDir, tmpDir, timeout / 2, false);
  }
}
