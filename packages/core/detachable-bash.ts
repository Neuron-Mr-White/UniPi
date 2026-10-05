import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLocalBashOperations, getShellConfig, truncateTail, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface BashBackgroundRequest {
  child: ChildProcess;
  command: string;
  cwd: string;
  startTime: number;
  initialOutput: string;
  reason: string;
}
export interface BashDetachResult { taskId: string; outputPath: string }
type Adopter = (request: BashBackgroundRequest) => Promise<BashDetachResult | null>;
let adopter: Adopter | null = null;
export function setBashBackgroundAdopter(callback: Adopter | null): void { adopter = callback; }
const calls = new Map<string, (reason: string) => Promise<BashDetachResult | null>>();
const context = new AsyncLocalStorage<{ toolCallId: string }>();
export async function detachBashCall(toolCallId: string, reason: string): Promise<BashDetachResult | null> {
  return calls.get(toolCallId)?.(reason) ?? null;
}
export async function detachCurrentBashCall(reason: string): Promise<BashDetachResult | null> {
  const id = [...calls.keys()].at(-1);
  return id ? detachBashCall(id, reason) : null;
}

type ShellHelpers = {
  getShellEnv(): NodeJS.ProcessEnv;
  killProcessTree(pid: number): void;
  trackDetachedChildPid(pid: number): void;
  untrackDetachedChildPid(pid: number): void;
};
type ProcessHelpers = { waitForChildProcess(child: ChildProcess): Promise<number | null> };

/**
 * pi's process helpers are not public exports, so they are loaded from pi's
 * dist on first use. Loading is lazy and never throws: if pi's layout differs
 * (another version, a bundled install, a loader without import.meta.resolve),
 * this resolves to null and exec falls back to pi's own createLocalBashOperations
 * — the call still runs exactly as before, it just cannot be detached.
 */
let helpers: Promise<{ shell: ShellHelpers; proc: ProcessHelpers } | null> | undefined;
function loadHelpers(): Promise<{ shell: ShellHelpers; proc: ProcessHelpers } | null> {
  helpers ??= (async () => {
    try {
      const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
      const [shell, proc] = await Promise.all([
        import(pathToFileURL(join(piDist, "utils/shell.js")).href) as Promise<ShellHelpers>,
        import(pathToFileURL(join(piDist, "utils/child-process.js")).href) as Promise<ProcessHelpers>,
      ]);
      const ok = typeof shell.getShellEnv === "function" && typeof shell.killProcessTree === "function"
        && typeof shell.trackDetachedChildPid === "function" && typeof shell.untrackDetachedChildPid === "function"
        && typeof proc.waitForChildProcess === "function";
      return ok ? { shell, proc } : null;
    } catch {
      return null;
    }
  })();
  return helpers;
}

class DetachedBash extends Error {
  constructor(readonly result: BashDetachResult, readonly output: Buffer, readonly age: number, readonly reason: string) {
    super("bash detached to background");
  }
}

export function createDetachableBashOperations(options?: { shellPath?: string }): BashOperations {
  const fallback = createLocalBashOperations({ shellPath: options?.shellPath });
  return {
    async exec(command, cwd, execOptions) {
      const loaded = await loadHelpers();
      if (!loaded) return fallback.exec(command, cwd, execOptions);
      const { onData, signal, timeout, env } = execOptions;
      const { shell, proc: { waitForChildProcess } } = loaded;
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)) {
        throw new Error(!Number.isFinite(timeout) || timeout <= 0 ? "Invalid timeout: must be a finite number of seconds" : "Invalid timeout: maximum is 2147483.647 seconds");
      }
      if (signal?.aborted) throw new Error("aborted");
      const config = getShellConfig(options?.shellPath);
      try { await access(cwd, constants.F_OK); }
      catch { throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`); }
      const stdin = config.commandTransport === "stdin";
      const child = spawn(config.shell, stdin ? config.args : [...config.args, command], {
        cwd, detached: process.platform !== "win32", env: env ?? shell.getShellEnv(),
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true,
      });
      if (stdin) { child.stdin?.on("error", () => {}); child.stdin?.end(command); }
      if (child.pid) shell.trackDetachedChildPid(child.pid);
      const id = context.getStore()?.toolCallId;
      const started = Date.now();
      const chunks: Buffer[] = [];
      let detached = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pendingDetach: Promise<BashDetachResult | null> | undefined;
      const onAbort = () => { if (!detached && child.pid) shell.killProcessTree(child.pid); };
      const receive = (data: Buffer) => { if (!detached) { chunks.push(Buffer.from(data)); onData(data); } };
      child.stdout?.on("data", receive);
      child.stderr?.on("data", receive);
      let rejectDetached!: (error: DetachedBash) => void;
      const early = new Promise<never>((_, reject) => { rejectDetached = reject; });
      const detach = (reason: string): Promise<BashDetachResult | null> => {
        if (pendingDetach) return pendingDetach;
        if (!adopter || !child.pid || child.exitCode !== null || child.signalCode !== null || detached) return Promise.resolve(null);
        const adopt = adopter;
        pendingDetach = (async () => {
          // Pause before adoption so initial bytes precede all future output.
          child.stdout?.pause(); child.stderr?.pause();
          const output = Buffer.concat(chunks);
          try {
            const result = await adopt({ child, command, cwd, startTime: started, initialOutput: output.toString("utf8"), reason });
            if (!result) return null;
            detached = true;
            child.stdout?.removeListener("data", receive); child.stderr?.removeListener("data", receive);
            signal?.removeEventListener("abort", onAbort);
            if (timer) clearTimeout(timer);
            if (child.pid) shell.untrackDetachedChildPid(child.pid);
            if (id) calls.delete(id);
            rejectDetached(new DetachedBash(result, output, (Date.now()-started)/1000, reason));
            return result;
          } catch {
            return null;
          } finally {
            child.stdout?.resume(); child.stderr?.resume();
            if (!detached) pendingDetach = undefined;
          }
        })();
        return pendingDetach;
      };
      if (id) calls.set(id, detach);
      if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; onAbort(); }, timeout*1000);
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
      const finished = waitForChildProcess(child).then(exitCode => {
        if (!detached && signal?.aborted) throw new Error("aborted");
        if (!detached && timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1) };
      });
      // After a detach nobody awaits `finished`; the background task owns the child now.
      finished.catch(() => {});
      try { return await Promise.race([finished, early]); }
      finally {
        if (id && calls.get(id) === detach) calls.delete(id);
        if (!detached && child.pid) shell.untrackDetachedChildPid(child.pid);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (!detached) { child.stdout?.removeListener("data", receive); child.stderr?.removeListener("data", receive); }
      }
    },
  };
}

export function withDetachableBash<T extends ToolDefinition>(definition: T): T {
  return { ...definition, execute: (...args: Parameters<T["execute"]>) => context.run({ toolCallId: args[0] }, async () => {
    try { return await definition.execute(args[0], args[1], args[2], args[3], args[4]); }
    catch (error) {
      if (!(error instanceof DetachedBash)) throw error;
      const full = error.output.toString("utf8");
      const truncation = truncateTail(full);
      let text = truncation.content || "(no output)";
      let fullOutputPath: string | undefined;
      if (truncation.truncated) {
        fullOutputPath = join(await mkdtemp(join(tmpdir(), "pi-bash-")), "output.log");
        await writeFile(fullOutputPath, error.output);
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        text += truncation.lastLinePartial
          ? `\n\n[Showing last ${truncation.outputBytes} bytes of line ${endLine}. Full output: ${fullOutputPath}]`
          : `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${truncation.truncatedBy === "bytes" ? " (50KB limit)" : ""}. Full output: ${fullOutputPath}]`;
      }
      text += `\n\n[watchdog] This command was moved to the background after ${Math.round(error.age)}s because it looks stuck (${error.reason}). It is still running as background task ${error.result.taskId} (output: ${error.result.outputPath}). You will be notified when it finishes. Check it with bg_logs ${error.result.taskId}; stop it with bg_kill ${error.result.taskId} if it is hung, or carry on with other work.`;
      return { content: [{ type: "text" as const, text }], isError: false,
        details: { detachedToTask: error.result.taskId, ...(truncation.truncated ? { truncation, fullOutputPath } : {}) } };
    }
  }) } as T;
}
