import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations, truncateTail, type BashOperations, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export class ProxyChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = undefined;
  constructor(private readonly stop: () => void) { super(); }
  kill(): boolean { this.stop(); return true; }
}
export interface BashBackgroundRequest {
  child: ProxyChild;
  stop: () => void;
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

class DetachedBash extends Error {
  constructor(readonly result: BashDetachResult, readonly output: Buffer, readonly age: number, readonly reason: string) {
    super("bash detached to background");
  }
}

export function createDetachableBashOperations(options?: { shellPath?: string }): BashOperations {
  const local = createLocalBashOperations({ shellPath: options?.shellPath });
  return {
    async exec(command, cwd, opts) {
      const id = context.getStore()?.toolCallId;
      if (!id) return local.exec(command, cwd, opts);
      const controller = new AbortController();
      const stop = () => controller.abort();
      if (opts.signal?.aborted) stop();
      else opts.signal?.addEventListener("abort", stop, { once: true });
      const started = Date.now();
      const chunks: Buffer[] = [];
      let detached = false;
      let settled = false;
      let proxy: ProxyChild | undefined;
      let pending: Promise<BashDetachResult | null> | undefined;
      let rejectEarly!: (error: DetachedBash) => void;
      const early = new Promise<never>((_, reject) => { rejectEarly = reject; });
      const inner = local.exec(command, cwd, { ...opts, signal: controller.signal, onData: (data) => {
        if (detached) proxy!.stdout.emit("data", data);
        else { chunks.push(Buffer.from(data)); opts.onData(data); }
      } });
      inner.then(({ exitCode }) => {
        settled = true;
        if (detached) proxy!.emit("close", exitCode, null);
      }, (error) => {
        settled = true;
        if (!detached) return;
        if (error instanceof Error && (error.message === "aborted" || error.message.startsWith("timeout:"))) {
          proxy!.emit("close", null, "SIGKILL");
        } else proxy!.emit("error", error);
      }).catch(() => {});
      inner.catch(() => {});
      const detach = (reason: string): Promise<BashDetachResult | null> => {
        if (detached || settled || !adopter) return Promise.resolve(null);
        if (pending) return pending;
        const adopt = adopter;
        proxy = new ProxyChild(stop);
        const initial = Buffer.concat(chunks);
        const initialCount = chunks.length;
        pending = (async () => {
          try {
            const result = await adopt({ child: proxy!, stop, command, cwd, startTime: started,
              initialOutput: initial.toString("utf8"), reason });
            if (!result) return null;
            detached = true;
            opts.signal?.removeEventListener("abort", stop);
            calls.delete(id);
            rejectEarly(new DetachedBash(result, Buffer.concat(chunks), (Date.now()-started)/1000, reason));
            for (const chunk of chunks.slice(initialCount)) proxy!.stdout.emit("data", chunk);
            chunks.length = 0;
            // Settlement can race asynchronous adoption; publish it after wiring is ready.
            if (settled) inner.then(({ exitCode }) => proxy!.emit("close", exitCode, null), (error) => {
              if (error instanceof Error && (error.message === "aborted" || error.message.startsWith("timeout:"))) proxy!.emit("close", null, "SIGKILL");
              else proxy!.emit("error", error);
            }).catch(() => {});
            return result;
          } catch { return null; }
          finally { pending = undefined; }
        })();
        return pending;
      };
      calls.set(id, detach);
      try { return await Promise.race([inner, early]); }
      finally {
        opts.signal?.removeEventListener("abort", stop);
        if (calls.get(id) === detach) calls.delete(id);
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
