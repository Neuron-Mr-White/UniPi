/**
 * @pi-unipi/subagents — workflowScript sandbox worker
 *
 * Ported from pi-subagents src/workflows/scripted-workflow.ts (worker half).
 * Runs inside a Worker thread: validates the script (acorn AST — no nested
 * async helpers), compiles it into a vm context with { runs, state, emit,
 * console, Promise } globals, and bridges calls back to the host via
 * parentPort RPC. No filesystem, shell, or host globals reach the script.
 */

import { parentPort, workerData } from "node:worker_threads";
import { inspect } from "node:util";
import { createRequire } from "node:module";
import vm from "node:vm";

const { parse } = createRequire(import.meta.url)(workerData.acornPath as string) as {
  parse: (source: string, options: { ecmaVersion: string; sourceType: string }) => unknown;
};

type PendingEntry = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const pending = new Map<number, PendingEntry>();
let nextCallId = 0;

const runKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const NESTED_ASYNC_WORKFLOW_ERROR =
  "workflowScript does not support nested async functions. Use top-level await, plain helper functions that return runs.run(...), or explicit Promise chains so workflows stay portable across Node and Bun.";
const AST_SCALAR_KEYS = new Set(["type", "start", "end"]);

function isAsyncFunctionNode(node: unknown): boolean {
  return (
    !!node &&
    typeof node === "object" &&
    (node as { async?: unknown }).async === true &&
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
      (node as { type?: unknown }).type as string,
    )
  );
}

function walkWorkflowAst(node: unknown, allowedAsyncFunction: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkWorkflowAst(item, allowedAsyncFunction);
    return;
  }
  if (node !== allowedAsyncFunction && isAsyncFunctionNode(node)) {
    throw new Error(NESTED_ASYNC_WORKFLOW_ERROR);
  }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (AST_SCALAR_KEYS.has(key)) continue;
    walkWorkflowAst(child, allowedAsyncFunction);
  }
}

function workflowWrapperFunction(ast: unknown): unknown {
  const wrapper = (
    ast as { body?: Array<{ expression?: { callee?: unknown } }> }
  ).body?.[0]?.expression?.callee;
  if (
    !wrapper ||
    (wrapper as { type?: unknown }).type !== "ArrowFunctionExpression"
  ) {
    throw new Error("workflowScript wrapper parse invariant failed.");
  }
  return wrapper;
}

function assertPortableWorkflowScript(source: string): void {
  const wrapped = "(async () => {\n" + source + "\n})()";
  const ast = parse(wrapped, { ecmaVersion: "latest", sourceType: "script" });
  const wrapper = workflowWrapperFunction(ast);
  walkWorkflowAst(
    (wrapper as { body?: unknown }).body,
    wrapper,
  );
}

let contextObjectPrototype: object | undefined;

function assertJsonValue(value: unknown, path = "emit", seen = new Set<unknown>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(path + " must contain only finite JSON numbers.");
    return;
  }
  if (typeof value !== "object") throw new Error(path + " must be a JSON value; received " + typeof value + ".");
  if (seen.has(value)) throw new Error(path + " must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error(path + " must not contain sparse array entries.");
      }
      assertJsonValue(value[index], path + "[" + index + "]", seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== null &&
      prototype !== Object.prototype &&
      prototype !== contextObjectPrototype
    ) {
      throw new Error(path + " must contain only plain JSON objects.");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(path + " must not contain symbol keys.");
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, path + "." + key, seen);
    }
  }
  seen.delete(value);
}

function stableRunJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRunJson).join(",")}]`;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableRunJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function hostCall(method: string, args: unknown, observation?: { key?: string; operation?: string }): Promise<unknown> {
  const callId = ++nextCallId;
  const promise = new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    parentPort!.postMessage({ type: "call", callId, method, args });
  });
  if (!observation) return promise;
  // Await-observation: the script consuming .then/.catch/.finally marks the
  // call observed so the host can enforce the unawaited-launch contract.
  let observed = false;
  const markObserved = () => {
    if (observed) return;
    observed = true;
    parentPort!.postMessage({ type: "callObserved", callId, key: observation.key, operation: observation.operation });
  };
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => unknown;
        return function (this: unknown, ...args: unknown[]): unknown {
          markObserved();
          return fn.apply(target, args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Promise<unknown>;
}

function validateRunCall(key: unknown, params: unknown, label: string, fingerprints: Map<string, string>): void {
  if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error(label + " has an invalid key.");
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(label + " requires a params object.");
  }
  const p = params as Record<string, unknown>;
  for (const forbidden of ["action", "workflowScript", "tasks", "chain", "parallel", "concurrency", "chainDir"]) {
    if (Object.prototype.hasOwnProperty.call(p, forbidden)) {
      const hint = label === "runs.run" ? "; use runs.all(...) and JavaScript control flow for orchestration." : ".";
      throw new Error(label + " accepts one child via { agent, task } and execution controls only" + hint);
    }
  }
  if (Object.prototype.hasOwnProperty.call(p, "clarify")) {
    throw new Error(label + " does not support clarify UI.");
  }
  if (p.worktree !== undefined && typeof p.worktree !== "boolean") {
    throw new Error(label + " worktree must be true or false.");
  }
  if (p.resume !== undefined && p.agent !== undefined) {
    throw new Error(label + " resume and agent are mutually exclusive.");
  }
  if (typeof p.resume === "string" && !p.resume.trim()) {
    throw new Error(label + " resume must be a non-empty retained run id.");
  }
  if (p.resume !== undefined && (typeof p.task !== "string" || !(p.task as string).trim())) {
    throw new Error(label + " resume requires a non-empty task follow-up.");
  }
  assertJsonValue(params, label + " params");
  const fingerprint = stableRunJson(params);
  const existing = fingerprints.get(key);
  if (existing !== undefined && existing !== fingerprint) {
    throw new Error("Duplicate workflow key '" + key + "' used with incompatible launch params.");
  }
  fingerprints.set(key, fingerprint);
}

const runs = Object.freeze({
  run(key: unknown, params: unknown): Promise<unknown> {
    validateRunCall(key, params, "runs.run", runFingerprints);
    return hostCall("run", { key, params }, { key: key as string, operation: "run" });
  },
  all(items: unknown): Promise<unknown> {
    if (!Array.isArray(items)) throw new Error("runs.all(items) requires an array.");
    const fingerprints = new Map(runFingerprints);
    const calls: Array<{ key: string; params: Record<string, unknown> }> = [];
    for (let index = 0; index < items.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(items, index)) {
        throw new Error("runs.all items must not contain sparse entries.");
      }
      const item = items[index];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("runs.all item " + index + " must be an object.");
      }
      const { key, ...params } = item as { key: unknown };
      validateRunCall(key, params, "runs.all item " + index, fingerprints);
      calls.push({ key: key as string, params: params as Record<string, unknown> });
    }
    runFingerprints = fingerprints;
    return hostCall("all", { calls }, { operation: "all" });
  },
  steer(key: unknown, message: unknown, options: unknown = {}): Promise<unknown> {
    if (typeof key !== "string" || !runKeyPattern.test(key)) throw new Error("runs.steer has an invalid key.");
    if (typeof message !== "string" || !message.trim()) throw new Error("runs.steer message must be a non-empty string.");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("runs.steer options must be an object.");
    }
    const allowed = new Set(["mode", "index", "ackTimeoutMs"]);
    for (const option of Object.keys(options as Record<string, unknown>)) {
      if (!allowed.has(option)) throw new Error("runs.steer options contain unsupported field '" + option + "'.");
    }
    const o = options as Record<string, unknown>;
    if (o.mode !== undefined && o.mode !== "steer" && o.mode !== "follow_up" && o.mode !== "auto") {
      throw new Error("runs.steer mode must be 'steer', 'follow_up', or 'auto'.");
    }
    return hostCall("steer", { key, message: (message as string).trim(), options }, { key: key as string, operation: "steer" });
  },
  status(keyOrRunId: unknown): Promise<unknown> {
    return hostCall("status", { keyOrRunId });
  },
  ref(result: unknown): string {
    if (!result || typeof result !== "object") throw new Error("runs.ref(result) requires a run result object.");
    const r = result as { key?: unknown; runId?: unknown };
    const parts = ["run " + (r.key || "unknown")];
    if (r.runId) parts.push("id=" + String(r.runId).slice(0, 8));
    return "[" + parts.join("; ") + "]";
  },
  refs(results: unknown): string {
    if (!Array.isArray(results)) throw new Error("runs.refs(results) requires an array.");
    return results.map((result) => runs.ref(result)).join("\n");
  },
});

let runFingerprints = new Map<string, string>();

function validateStateKey(key: unknown): string {
  if (typeof key !== "string" || !runKeyPattern.test(key)) {
    throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
  }
  return key;
}

const state = Object.freeze({
  get(key: unknown): Promise<unknown> {
    return hostCall("state.get", { key: validateStateKey(key) });
  },
  set(key: unknown, value: unknown): Promise<unknown> {
    const validKey = validateStateKey(key);
    assertJsonValue(value, "state.set('" + validKey + "') value");
    return hostCall("state.set", { key: validKey, value });
  },
});

const capturedConsole = Object.freeze(
  Object.fromEntries(
    (["log", "info", "warn", "error"] as const).map((level) => [
      level,
      (...args: unknown[]) => {
        parentPort!.postMessage({
          type: "console",
          level,
          text: args
            .map((value) => (typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 120 })))
            .join(" "),
        });
      },
    ]),
  ),
);

function formatWorkflowScriptError(error: unknown): string {
  const message = error && typeof (error as Error).message === "string" ? (error as Error).message : String(error);
  const stack = error && typeof (error as Error).stack === "string" ? (error as Error).stack : "";
  if (!stack) return message;
  return stack.includes(message) ? stack : message + "\n" + stack;
}

function isSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError || (error as { name?: unknown } | null)?.name === "SyntaxError";
}

function formatWorkflowScriptSyntaxError(error: unknown): string {
  const details = formatWorkflowScriptError(error);
  return [
    "workflowScript must be valid JavaScript.",
    'If task text contains Markdown fences or backticks, use an array joined with "\\n" or escaped strings instead of a raw backtick template literal.',
    "",
    "Original SyntaxError:",
    details,
  ].join("\n");
}

parentPort!.on("message", (message: Record<string, unknown>) => {
  if (message.type === "response") {
    const entry = pending.get(message.callId as number);
    if (!entry) return;
    pending.delete(message.callId as number);
    if (message.ok) entry.resolve(message.value);
    else {
      const error = new Error(String(message.error));
      if (message.errorKind === "detached-child") {
        (error as Error & { workflowErrorKind?: string }).workflowErrorKind = "detached-child";
      }
      entry.reject(error);
    }
    return;
  }
  if (message.type !== "start") return;

  try {
    const sandbox: Record<string, unknown> = {
      runs,
      emit(value: unknown): void {
        assertJsonValue(value);
        parentPort!.postMessage({ type: "emit", value });
      },
      console: capturedConsole,
    };
    if (message.stateEnabled) sandbox.state = state;
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    contextObjectPrototype = vm.runInContext("Object.prototype", context) as object;

    let compiled: vm.Script;
    try {
      assertPortableWorkflowScript(String(message.script));
      compiled = new vm.Script("(async () => {\n" + String(message.script) + "\n})()", {
        filename: "workflow-script.js",
      });
    } catch (error) {
      parentPort!.postMessage({
        type: "error",
        error: isSyntaxError(error) ? formatWorkflowScriptSyntaxError(error) : formatWorkflowScriptError(error),
      });
      return;
    }

    compiled
      .runInContext(context)
      .then(
        (value: unknown) => {
          try {
            // Ordinary statement-body semantics: a script without an explicit
            // return resolves undefined, which serializes as null (reference test).
            const normalized = value === undefined ? null : value;
            assertJsonValue(normalized, "return");
            parentPort!.postMessage({ type: "complete", value: normalized });
          } catch (error) {
            parentPort!.postMessage({
              type: "error",
              error:
                "Workflow return could not be persisted: " +
                (error instanceof Error ? error.message : String(error)),
            });
          }
        },
        (error: unknown) => {
          const e = error as Error & { workflowErrorKind?: unknown };
          parentPort!.postMessage({
            type: "error",
            error: formatWorkflowScriptError(error),
            ...(e?.workflowErrorKind === "detached-child" ? { errorKind: "detached-child" } : {}),
          });
        },
      )
      .catch(() => {
        // Post-message failures above are already best-effort; never crash the worker.
      });
  } catch (error) {
    parentPort!.postMessage({ type: "error", error: formatWorkflowScriptError(error) });
  }
});
