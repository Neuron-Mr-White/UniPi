/**
 * @pi-unipi/subagents — workflowScript host runtime
 *
 * Ported from pi-subagents src/workflows/scripted-workflow.ts (host half).
 * Spawns the sandbox worker, routes RPC calls (run/all/steer/status/state) to
 * host callbacks, tracks children + trace, enforces the unawaited-launch
 * contract, and resolves with { value, emits, console, trace, children }.
 *
 * The launch callback is OURS: in-process AgentManager.spawn (foreground) —
 * Phase 3 swaps in the process-based runner for async workflows.
 */

import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromPackage = createRequire(import.meta.url);

export interface WorkflowScriptTraceEntry {
  operation: "run" | "steer" | "status";
  key: string;
  state: string;
  durationMs?: number;
  phase?: string;
  label?: string;
  agent?: string;
  runId?: string;
  error?: string;
}

export interface WorkflowScriptChildResult {
  key: string;
  ok: boolean;
  output: string;
  error?: string;
  detached?: boolean;
  runId?: string;
  agent?: string;
  artifactPaths?: string[];
  [extra: string]: unknown;
}

export interface WorkflowSteerResult {
  key: string;
  state: "queued" | "delivered" | "missed" | "failed";
  requestId?: string;
  error?: string;
}

export interface WorkflowScriptResult {
  value: unknown;
  emits: unknown[];
  console: Array<{ level: "log" | "info" | "warn" | "error"; text: string }>;
  trace: WorkflowScriptTraceEntry[];
  children: WorkflowScriptChildResult[];
}

export class WorkflowScriptError extends Error {
  readonly partial: Omit<WorkflowScriptResult, "value">;

  constructor(message: string, partial: Omit<WorkflowScriptResult, "value">) {
    super(message);
    this.name = "WorkflowScriptError";
    this.partial = partial;
  }
}

export interface RunWorkflowScriptOptions {
  script: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Spawn-budget admission hook (called before children start; may throw). */
  admit?: (calls: Array<{ key: string; params: Record<string, unknown> }>) => void | Promise<void>;
  /** OUR launch path: in-process foreground spawn (Phase 3: process runner). */
  launch: (
    key: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    admission: { admitted: boolean },
  ) => Promise<WorkflowScriptChildResult>;
  status: (keyOrRunId: string, signal: AbortSignal) => Promise<WorkflowScriptChildResult>;
  steer?: (
    key: string,
    message: string,
    options: { mode?: string; index?: number; ackTimeoutMs?: number },
    signal: AbortSignal,
  ) => Promise<WorkflowSteerResult>;
  state?: {
    get: (key: string) => unknown | Promise<unknown>;
    set: (key: string, value: unknown) => void | Promise<void>;
  };
  onTrace?: (trace: WorkflowScriptTraceEntry[]) => void;
  onEmit?: (emits: unknown[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function assertWorkflowJsonValue(value: unknown, path = "value", seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} must be a JSON value; received ${typeof value}.`);
  if (seen.has(value)) throw new Error(`${path} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new Error(`${path} must not contain sparse array entries.`);
      assertWorkflowJsonValue(value[index], `${path}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new Error(`${path} must contain only plain JSON objects.`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(`${path} must not contain symbol keys.`);
    }
    for (const [key, entry] of Object.entries(value)) {
      assertWorkflowJsonValue(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function formatWorkflowJsonPreview(value: unknown, maxLength: number): string | undefined {
  try {
    assertWorkflowJsonValue(value);
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.slice(0, maxLength) : undefined;
  } catch {
    return undefined;
  }
}

export interface SimpleWorkflowRunPreview {
  agent?: string;
  task?: string;
}

/** Display-only preview for the exact simple `return runs.run(key, {...})` form. */
export function previewSimpleWorkflowRun(script: string | undefined): SimpleWorkflowRunPreview | undefined {
  const body = script
    ?.match(/^\s*return\s+(?:await\s+)?runs\.run\s*\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`$\\]*`)\s*,\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/)
    ?.[1];
  if (body === undefined) return undefined;
  const readProperty = (name: "agent" | "task"): string | undefined => {
    const match = body.match(
      new RegExp(`(?:^|,)\\s*(?:${name}|["']${name}["'])\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\u0060[^\u0060$\\\\]*\u0060)`),
    );
    if (!match?.[1]) return undefined;
    const literal = match[1];
    if (literal.startsWith('"')) {
      try {
        return JSON.parse(literal) as string;
      } catch {
        return undefined;
      }
    }
    if (literal.slice(1, -1).includes("\\")) return undefined;
    return literal.slice(1, -1);
  };
  const agent = readProperty("agent");
  const task = readProperty("task");
  return { ...(agent !== undefined ? { agent } : {}), ...(task !== undefined ? { task } : {}) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function omitUndefinedWorkflowValues(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const normalized = Array.isArray(value)
    ? value.map((entry) => (entry === undefined ? null : omitUndefinedWorkflowValues(entry, seen)))
    : isPlainJsonObject(value)
      ? Object.fromEntries(
          Object.entries(value).flatMap(([key, entry]) =>
            entry === undefined ? [] : [[key, omitUndefinedWorkflowValues(entry, seen)]],
          ),
        )
      : value;
  seen.delete(value);
  return normalized;
}

function omitNonJsonWorkflowResultMetadata(value: unknown): unknown {
  const normalized = omitUndefinedWorkflowValues(value);
  if (!isPlainJsonObject(normalized) || !Object.hasOwn(normalized, "results")) return normalized;
  try {
    assertWorkflowJsonValue(normalized.results, "runs.run result.results");
    return normalized;
  } catch {
    const { results: _results, ...safeResult } = normalized;
    return safeResult;
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateKey(value: unknown, owner = "runs.run"): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new Error(`${owner} key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.`);
  }
  return value;
}

function workflowStringMetadata(params: Record<string, unknown>): Pick<WorkflowScriptTraceEntry, "phase" | "label" | "agent"> {
  return {
    ...(typeof params.phase === "string" && params.phase.trim() ? { phase: params.phase.trim() } : {}),
    ...(typeof params.label === "string" && params.label.trim() ? { label: params.label.trim() } : {}),
    ...(typeof params.agent === "string" && params.agent.trim() ? { agent: params.agent.trim() } : {}),
  };
}

/** Resolve acorn robustly (bare specifier, then package.json main). */
function resolveWorkflowParserEntry(): string {
  try {
    return requireFromPackage.resolve("acorn");
  } catch (primaryError) {
    try {
      const manifestPath = requireFromPackage.resolve("acorn/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { main?: unknown };
      const entry = typeof manifest.main === "string" && manifest.main ? manifest.main : "./dist/acorn.js";
      return resolvePath(dirname(manifestPath), entry);
    } catch {
      throw primaryError;
    }
  }
}

/** Worker source: compiled .js in published installs, .ts under jiti/tsx (transpiled inline). */
function loadWorkerSource(): string {
  const base = resolvePath(dirname(fileURLToPath(import.meta.url)), "workflow-worker");
  for (const candidate of [`${base}.js`, `${base}.ts`]) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  throw new Error("workflow-worker source not found (expected workflow-worker.js or .ts)");
}

export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
  if (!options.script.trim()) throw new Error("workflowScript must not be empty.");
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error("workflow script timeout must be a positive integer.");
  }

  let acornPath: string;
  try {
    acornPath = resolveWorkflowParserEntry();
  } catch (error) {
    throw new Error(
      "Workflow parser dependency 'acorn' is unavailable from @pi-unipi/subagents. Reinstall dependencies before launching workflowScript.",
      { cause: error },
    );
  }

  const worker = new Worker(loadWorkerSource(), { eval: true, workerData: { acornPath } });
  const emits: unknown[] = [];
  const consoleEntries: WorkflowScriptResult["console"] = [];
  const trace: WorkflowScriptTraceEntry[] = [];
  const children = new Map<string, WorkflowScriptChildResult>();
  const childOrder: string[] = [];
  const launches = new Map<string, { fingerprint: string; promise: Promise<WorkflowScriptChildResult>; observed: boolean }>();
  const steers = new Map<number, { key: string; promise: Promise<WorkflowSteerResult>; observed: boolean }>();
  const stoppedLaunches = new Set<string>();
  const batchAdmissions = new Map<string, Promise<void>>();
  const childController = new AbortController();
  let settled = false;
  let finishing = false;

  const partial = (): Omit<WorkflowScriptResult, "value"> => ({
    emits,
    console: consoleEntries,
    trace,
    children: childOrder.flatMap((key) => {
      const child = children.get(key);
      return child ? [child] : [];
    }),
  });

  const traceChanged = () => {
    try {
      options.onTrace?.([...trace]);
    } catch (error) {
      console.error("Workflow onTrace callback failed:", error);
    }
  };

  return await new Promise<WorkflowScriptResult>((resolve, reject) => {
    const finish = (outcome: { value: unknown } | { error: Error }) => {
      if (settled || finishing) return;
      finishing = true;
      childController.abort("error" in outcome ? outcome.error : new Error("Workflow script completed."));
      void Promise.allSettled([...steers.values()].map(({ promise }) => promise)).then(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        const unobservedKeys =
          "value" in outcome ? [...launches].filter(([, launch]) => !launch.observed).map(([key]) => key) : [];
        const completionError =
          unobservedKeys.length > 0
            ? new Error(
                `workflowScript completed with unawaited runs.run launch(es): ${unobservedKeys.map((key) => `'${key}'`).join(", ")}. For ordinary parallel fanout use await runs.all([{key, agent, task}, ...]); do not read .output from unawaited launches.`,
              )
            : "value" in outcome
              ? (() => {
                  const unobservedSteers = [...steers.values()].filter((steer) => !steer.observed).map((steer) => steer.key);
                  return unobservedSteers.length > 0
                    ? new Error(`workflowScript completed with unawaited runs.steer call(s): ${unobservedSteers.map((key) => `'${key}'`).join(", ")}. Await or return each call.`)
                    : undefined;
                })()
              : undefined;
        if ("error" in outcome) reject(new WorkflowScriptError(outcome.error.message, partial()));
        else if (completionError) reject(new WorkflowScriptError(completionError.message, partial()));
        else resolve({ value: outcome.value, ...partial() });
      });
    };
    const onAbort = () => {
      const signalReason = options.signal?.reason;
      const error =
        signalReason instanceof Error
          ? signalReason
          : typeof signalReason === "string"
            ? new Error(signalReason)
            : new Error("Workflow script aborted.");
      for (const key of launches.keys()) {
        if (children.has(key)) continue;
        stoppedLaunches.add(key);
        const started = trace.findLast(
          (entry) => entry.operation === "run" && entry.key === key && entry.state === "started",
        );
        trace.push({
          operation: "run",
          key,
          state: "stopped",
          ...(started?.agent ? { agent: started.agent } : {}),
          ...(started?.phase ? { phase: started.phase } : {}),
          ...(started?.label ? { label: started.label } : {}),
          error: error.message,
        });
      }
      traceChanged();
      finish({ error });
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => finish({ error: new Error(`Workflow script timed out after ${options.timeoutMs}ms.`) }), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();

    worker.on("error", (error) =>
      finish({ error: new Error(`Workflow worker failed: ${error instanceof Error ? error.message : String(error)}`) }),
    );
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish({ error: new Error(`Workflow worker exited with code ${code}.`) });
    });


    worker.on("message", (msg: Record<string, unknown>) => {
      if (settled) return;
      if (msg.type === "emit") {
        try {
          assertWorkflowJsonValue(msg.value, "emit");
        } catch (error) {
          finish({ error: new Error(`Workflow emit could not be persisted: ${error instanceof Error ? error.message : String(error)}`) });
          return;
        }
        emits.push(msg.value);
        try {
          options.onEmit?.([...emits]);
        } catch (error) {
          emits.pop();
          finish({ error: new Error(`Workflow emit could not be persisted: ${error instanceof Error ? error.message : String(error)}`) });
        }
        return;
      }
      if (msg.type === "console") {
        const level = msg.level;
        if ((level === "log" || level === "info" || level === "warn" || level === "error") && typeof msg.text === "string") {
          consoleEntries.push({ level, text: msg.text });
        }
        return;
      }
      if (msg.type === "complete") {
        try {
          assertWorkflowJsonValue(msg.value, "return");
        } catch (error) {
          return finish({ error: new Error(`Workflow return could not be persisted: ${error instanceof Error ? error.message : String(error)}`) });
        }
        return finish({ value: msg.value });
      }
      if (msg.type === "error") {
        return finish({ error: new Error(typeof msg.error === "string" ? msg.error : "Workflow script failed.") });
      }
      if (msg.type === "callObserved" && typeof msg.callId === "number") {
        if (msg.operation === "steer") {
          const steer = steers.get(msg.callId);
          if (steer) steer.observed = true;
        }
        // run/all observations are tracked via the launches map by key.
        return;
      }
      if (msg.type !== "call" || typeof msg.callId !== "number" || typeof msg.method !== "string" || !isRecord(msg.args)) {
        return;
      }

      const respond = (promise: Promise<unknown>, responsePath?: string) => {
        void promise.then(
          (value) => {
            if (settled) return;
            const normalized = responsePath ? omitNonJsonWorkflowResultMetadata(value) : omitUndefinedWorkflowValues(value);
            if (!responsePath) {
              worker.postMessage({ type: "response", callId: msg.callId, ok: true, value: normalized });
              return;
            }
            try {
              assertWorkflowJsonValue(normalized, responsePath);
              worker.postMessage({ type: "response", callId: msg.callId, ok: true, value: normalized });
            } catch (error) {
              worker.postMessage({
                type: "response",
                callId: msg.callId,
                ok: false,
                error: `${responsePath} must contain only JSON data before it can be returned from workflowScript. Return a plain projection such as { runId, ok, output }. ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          },
          (error: unknown) => {
            if (!settled) {
              worker.postMessage({
                type: "response",
                callId: msg.callId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
        );
      };

      if (msg.method === "state.get" || msg.method === "state.set") {
        if (!options.state) return respond(Promise.reject(new Error("Workflow state is unavailable without a mission.")));
        let key: string;
        try {
          key = validateKey(msg.args.key, "state");
        } catch (error) {
          return respond(Promise.reject(error));
        }
        if (msg.method === "state.get") return respond(Promise.resolve().then(() => options.state!.get(key)));
        const value = msg.args.value;
        try {
          assertWorkflowJsonValue(value, `state.set('${key}') value`);
        } catch (error) {
          return respond(Promise.reject(error));
        }
        return respond(Promise.resolve().then(() => options.state!.set(key, value)));
      }

      if (msg.method === "status") {
        const keyOrRunId = msg.args.keyOrRunId;
        if (typeof keyOrRunId !== "string" || !keyOrRunId.trim()) {
          return respond(Promise.reject(new Error("runs.status(keyOrRunId) requires a non-empty string.")));
        }
        const known = children.get(keyOrRunId);
        const target = known?.runId ?? keyOrRunId;
        trace.push({ operation: "status", key: keyOrRunId, state: "started", ...(known?.runId ? { runId: known.runId } : {}) });
        traceChanged();
        if (settled || finishing) return;
        respond(
          options.status(target, childController.signal).then((result) => {
            if (settled || finishing) return result;
            trace.push({
              operation: "status",
              key: keyOrRunId,
              state: result.ok ? "completed" : "failed",
              ...(result.runId ? { runId: result.runId } : {}),
              ...(!result.ok ? { error: result.output } : {}),
            });
            traceChanged();
            if (!result.ok) throw new Error(`Status '${keyOrRunId}' failed: ${result.output}`);
            return result;
          }),
        );
        return;
      }

      if (msg.method === "steer") {
        let key: string;
        try {
          key = validateKey(msg.args.key, "runs.steer");
        } catch (error) {
          return respond(Promise.reject(error));
        }
        const steerMessage = msg.args.message;
        if (typeof steerMessage !== "string" || !steerMessage.trim()) {
          return respond(Promise.reject(new Error(`runs.steer('${key}') requires a non-empty message.`)));
        }
        const steerOptions = isRecord(msg.args.options) ? (msg.args.options as { mode?: string; index?: number; ackTimeoutMs?: number }) : {};
        const startedAt = Date.now();
        trace.push({ operation: "steer", key, state: "started" });
        traceChanged();
        const promise = Promise.resolve()
          .then(() => {
            if (!launches.has(key)) throw new Error(`runs.steer('${key}') requires a prior runs.run/runs.all launch with that key.`);
            if (!options.steer) throw new Error("Workflow steering is unavailable in this host.");
            return options.steer(key, steerMessage.trim(), steerOptions, childController.signal);
          })
          .then(
            (receipt) => {
              trace.push({ operation: "steer", key, state: receipt.state, durationMs: Date.now() - startedAt, ...(receipt.error ? { error: receipt.error } : {}) });
              traceChanged();
              return receipt;
            },
            (error: unknown) => {
              const text = error instanceof Error ? error.message : String(error);
              trace.push({ operation: "steer", key, state: "failed", durationMs: Date.now() - startedAt, error: text });
              traceChanged();
              throw error;
            },
          );
        steers.set(msg.callId, { key, promise, observed: false });
        respond(promise);
        return;
      }

      if (msg.method === "all") {
        // runs.all(...) is itself the observation: every child is awaited by the batch.
        // Batch launch: runs.all([...]) — admits the whole group atomically.
        const calls = Array.isArray(msg.args.calls) ? msg.args.calls : [];
        const valid = calls.filter(
          (call): call is { key: string; params: Record<string, unknown> } =>
            isRecord(call) && typeof call.key === "string" && isRecord(call.params),
        );
        const admission = Promise.resolve().then(() => {
          if (settled || finishing) return;
          return options.admit?.(valid);
        }).catch((error: unknown) => {
          // Admission failures (e.g. fanout budget) reject every child in the
          // batch; runs.all collects them as ordinary failures (reference
          // semantics: no partial starts, siblings report the rejection).
          const text = error instanceof Error ? error.message : String(error);
          for (const { key } of valid) {
            const failure: WorkflowScriptChildResult = { key, ok: false, output: text, error: text, artifactPaths: [] };
            children.set(key, failure);
            if (!childOrder.includes(key)) childOrder.push(key);
          }
          throw error;
        });
        const promises = valid.map(({ key, params }) =>
          admission.then(async () => {
            if (settled || finishing || stoppedLaunches.has(key)) {
              const reason = childController.signal.reason;
              const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Workflow script aborted.";
              return { key, ok: false, output: text, error: text, artifactPaths: [] };
            }
            const startedAt = Date.now();
            return options.launch(key, { ...params, async: params.async ?? false }, childController.signal, { admitted: true }).then(
              (result) => {
                const normalized = !result.ok && !result.error ? { ...result, error: result.output } : result;
                children.set(key, normalized);
                childOrder.push(key);
                trace.push({
                  operation: "run",
                  key,
                  state: normalized.ok ? "completed" : "failed",
                  durationMs: Date.now() - startedAt,
                  ...workflowStringMetadata(params),
                  ...(normalized.agent ? { agent: normalized.agent } : {}),
                  ...(normalized.runId ? { runId: normalized.runId } : {}),
                  ...(!normalized.ok ? { error: normalized.error ?? normalized.output } : {}),
                });
                traceChanged();
                return normalized;
              },
              (error: unknown) => {
                const text = error instanceof Error ? error.message : String(error);
                const failure: WorkflowScriptChildResult = { key, ok: false, output: text, error: text, artifactPaths: [] };
                children.set(key, failure);
                childOrder.push(key);
                trace.push({ operation: "run", key, state: "failed", durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), error: text });
                traceChanged();
                return failure;
              },
            );
          }, (error: unknown) => {
            // Admission rejection already recorded the failure per child; map
            // this arm to the same failure so Promise.all collects it.
            const text = error instanceof Error ? error.message : String(error);
            return { key, ok: false, output: text, error: text, artifactPaths: [] } satisfies WorkflowScriptChildResult;
          }),
        );
        // Mark all keys observed (runs.all is itself the observation).
        for (const { key } of valid) {
          const existing = launches.get(key);
          if (existing) existing.observed = true;
        }
        const batchPromise = Promise.all(promises).then((results) => {
          for (const result of results) {
            const entry = launches.get(result.key);
            if (entry) entry.observed = true;
          }
          return results;
        });
        for (const { key, params } of valid) {
          const fingerprint = stableJson(params);
          launches.set(key, { fingerprint, promise: batchPromise.then((rs) => rs.find((r) => r.key === key)!) , observed: true });
        }
        respond(batchPromise, "runs.all(...) results");
        return;
      }

      if (msg.method !== "run") return respond(Promise.reject(new Error(`Unknown runs API method '${msg.method}'.`)));

      let key: string;
      try {
        key = validateKey(msg.args.key);
      } catch (error) {
        return respond(Promise.reject(error));
      }
      const params = msg.args.params;
      if (!isRecord(params)) return respond(Promise.reject(new Error(`runs.run('${key}', params) requires a params object.`)));
      if (params.action !== undefined) return respond(Promise.reject(new Error(`runs.run('${key}') accepts execution params only; management action is not allowed.`)));
      if (params.workflowScript !== undefined) return respond(Promise.reject(new Error(`runs.run('${key}') cannot start a nested workflow script.`)));
      if (params.tasks !== undefined || params.chain !== undefined || params.parallel !== undefined || params.concurrency !== undefined) {
        return respond(Promise.reject(new Error(`runs.run('${key}') accepts one child via { agent, task }; use runs.all(...) and JavaScript control flow for orchestration.`)));
      }
      if (params.resume !== undefined && params.agent !== undefined) {
        return respond(Promise.reject(new Error(`runs.run('${key}') resume and agent are mutually exclusive.`)));
      }
      if (typeof params.resume === "string" && !params.resume.trim()) {
        return respond(Promise.reject(new Error(`runs.run('${key}') resume must be a non-empty retained run id.`)));
      }
      if (params.resume !== undefined && (typeof params.task !== "string" || !params.task.trim())) {
        return respond(Promise.reject(new Error(`runs.run('${key}') resume requires a non-empty task follow-up.`)));
      }

      const fingerprint = stableJson(params);
      const existing = launches.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return respond(Promise.reject(new Error(`Duplicate workflow key '${key}' used with incompatible launch params.`)));
        }
        existing.observed = true;
        trace.push({ operation: "run", key, state: "reused", ...workflowStringMetadata(params) });
        traceChanged();
        return respond(
          existing.promise.then((result) => {
            if (result.ok) return result;
            throw new Error(`Run '${key}' failed: ${result.error ?? result.output}`);
          }),
          `runs.run('${key}') result`,
        );
      }

      const startedAt = Date.now();
      const admission = Promise.resolve().then(() => {
        if (settled || finishing) return;
        return options.admit?.([{ key, params }]);
      });
      const promise = admission
        .then(async () => {
          if (settled || finishing || stoppedLaunches.has(key)) {
            const reason = childController.signal.reason;
            const text = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Workflow script aborted.";
            return { key, ok: false, output: text, error: text, artifactPaths: [] };
          }
          return options.launch(key, { ...params, async: params.async ?? false }, childController.signal, { admitted: true });
        })
        .then(
          (result) => {
            const normalized = !result.ok && !result.error ? { ...result, error: result.output } : result;
            if (stoppedLaunches.has(key)) return normalized;
            children.set(key, normalized);
            const state = normalized.ok ? "completed" : "failed";
            trace.push({
              operation: "run",
              key,
              state,
              durationMs: Date.now() - startedAt,
              ...workflowStringMetadata(params),
              ...(normalized.agent ? { agent: normalized.agent } : {}),
              ...(normalized.runId ? { runId: normalized.runId } : {}),
              ...(!normalized.ok ? { error: normalized.error ?? normalized.output } : {}),
            });
            traceChanged();
            return normalized;
          },
          (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            const failure: WorkflowScriptChildResult = { key, ok: false, output: text, error: text, artifactPaths: [] };
            if (stoppedLaunches.has(key)) return failure;
            children.set(key, failure);
            trace.push({ operation: "run", key, state: "failed", durationMs: Date.now() - startedAt, ...workflowStringMetadata(params), error: text });
            traceChanged();
            return failure;
          },
        );
      launches.set(key, { fingerprint, promise, observed: true });
      if (!childOrder.includes(key)) childOrder.push(key);
      trace.push({ operation: "run", key, state: "started", ...workflowStringMetadata(params) });
      traceChanged();
      respond(
        promise.then((result) => {
          if (result.ok) return result;
          throw new Error(`Run '${key}' failed: ${result.error ?? result.output}`);
        }),
        `runs.run('${key}') result`,
      );
    });

    worker.postMessage({ type: "start", script: options.script, stateEnabled: options.state !== undefined });
  });
}
