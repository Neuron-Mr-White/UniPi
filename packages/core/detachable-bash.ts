import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
// Namespace import on purpose (GH #41): a static named import of a runtime
// value hard-fails module linking on hosts whose pi-coding-agent surface lacks
// it (e.g. OMP's legacy-pi compat module has no createLocalBashOperations),
// which used to break EVERY package importing the @pi-unipi/core barrel —
// even notify, which never touches bash. Resolve lazily and feature-detect.
import * as piAgent from "@earendil-works/pi-coding-agent";

type LocalBashFactory = (options?: { shellPath?: string }) => BashOperations;
type TruncateTail = (text: string) => {
  content: string; truncated: boolean; totalLines: number; outputLines: number;
  outputBytes: number; lastLinePartial?: boolean; truncatedBy?: string | null;
};
const host = piAgent as unknown as { createLocalBashOperations?: LocalBashFactory; truncateTail?: TruncateTail };

/** True when the running pi host exposes what detachable bash needs. Hosts
 *  without it (OMP's legacy-pi compat layer) should keep their stock bash. */
export function detachableBashSupported(): boolean {
  return typeof host.createLocalBashOperations === "function";
}

/** Minimal tail truncation used only if the host lacks `truncateTail`. */
function fallbackTruncateTail(text: string): ReturnType<TruncateTail> {
  const lines = text.split("\n");
  const max = 2000;
  const kept = lines.length > max ? lines.slice(-max) : lines;
  return { content: kept.join("\n"), truncated: lines.length > max, totalLines: lines.length,
    outputLines: kept.length, outputBytes: Buffer.byteLength(kept.join("\n")), lastLinePartial: false, truncatedBy: lines.length > max ? "lines" : null };
}

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
  const factory = host.createLocalBashOperations;
  if (typeof factory !== "function") {
    throw new Error("createDetachableBashOperations: this pi host does not export createLocalBashOperations (check detachableBashSupported() first)");
  }
  const local = factory({ shellPath: options?.shellPath });
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
      const truncation = (host.truncateTail ?? fallbackTruncateTail)(full);
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
