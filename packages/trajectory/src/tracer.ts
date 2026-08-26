import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TelemetrySidecar, type TelemetryEvent } from "./telemetry.js";

export interface UnipiTraceRecorder {
  bind(sessionId: string): void;
  record(data: unknown, extra?: Record<string, unknown>): void;
  read(): TelemetryEvent[];
  revision(): number;
  cursor(): number;
  since(cursor: number): TelemetryEvent[];
}

export interface UnipiTracer {
  scope(packageName: string): ExtensionAPI;
  recorder: UnipiTraceRecorder;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: "number", value: String(value) };
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return { $type: "cycle" };
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (value instanceof Uint8Array) {
    seen.delete(value);
    return { $type: "bytes", length: value.byteLength };
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalize((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}

function mutationSurface(event: unknown): unknown {
  if (!event || typeof event !== "object") return undefined;
  const value = event as Record<string, unknown>;
  if (value.type === "context") return value.messages;
  if (value.type === "before_provider_request") return value.payload;
  if (value.type === "before_provider_headers") return value.headers;
  if (value.type === "before_agent_start") return { systemPrompt: value.systemPrompt };
  if (value.type === "input") return { text: value.text, images: value.images };
  if (value.type === "message_end") return value.message;
  if (value.type === "tool_call") return value.input;
  if (value.type === "tool_result") {
    return { content: value.content, details: value.details, isError: value.isError, usage: value.usage };
  }
  return undefined;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function sample(value: unknown): unknown {
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…[truncated]` : value;
  const text = JSON.stringify(value);
  return text.length > 1_000 ? `${text.slice(0, 1_000)}…[truncated]` : value;
}

function firstDifference(before: unknown, after: unknown, path = "$", depth = 0): Record<string, unknown> | undefined {
  if (Object.is(before, after)) return undefined;
  if (depth >= 20) return { path, kind: "changed", before: sample(before), after: sample(after) };
  if (Array.isArray(before) && Array.isArray(after)) {
    const count = Math.max(before.length, after.length);
    for (let index = 0; index < count; index++) {
      if (index >= before.length) return { path: `${path}[${index}]`, kind: "inserted", after: sample(after[index]) };
      if (index >= after.length) return { path: `${path}[${index}]`, kind: "removed", before: sample(before[index]) };
      const difference = firstDifference(before[index], after[index], `${path}[${index}]`, depth + 1);
      if (difference) return difference;
    }
    return undefined;
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort()) {
      if (!(key in beforeRecord)) return { path: `${path}.${key}`, kind: "inserted", after: sample(afterRecord[key]) };
      if (!(key in afterRecord)) return { path: `${path}.${key}`, kind: "removed", before: sample(beforeRecord[key]) };
      const difference = firstDifference(beforeRecord[key], afterRecord[key], `${path}.${key}`, depth + 1);
      if (difference) return difference;
    }
    return undefined;
  }
  return { path, kind: "changed", before: sample(before), after: sample(after) };
}

function mutationEvidence(before: unknown, after: unknown): Record<string, unknown> | undefined {
  if (before === undefined || after === undefined) return undefined;
  const beforeFingerprint = fingerprint(before);
  const afterFingerprint = fingerprint(after);
  return {
    changed: beforeFingerprint !== afterFingerprint,
    beforeFingerprint,
    afterFingerprint,
    ...(beforeFingerprint === afterFingerprint ? {} : { firstDifference: firstDifference(before, after) }),
  };
}

function effectiveSurface(eventName: string, event: unknown, result: unknown): unknown {
  const current = mutationSurface(event);
  if (!result || typeof result !== "object") {
    return eventName === "before_provider_request" && result !== undefined ? result : current;
  }
  const value = result as Record<string, unknown>;
  if (eventName === "context" && value.messages !== undefined) return value.messages;
  if (eventName === "before_provider_request") return result;
  if (eventName === "before_agent_start" && value.systemPrompt !== undefined) return { systemPrompt: value.systemPrompt };
  if (eventName === "input" && value.action === "transform") return { text: value.text, images: value.images };
  if (eventName === "message_end" && value.message !== undefined) return value.message;
  if (eventName === "tool_result" && current && typeof current === "object") {
    return { ...(current as Record<string, unknown>), ...value };
  }
  return current;
}

function resultEvidence(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined) return undefined;
  const canonical = canonicalize(result);
  return { fingerprint: fingerprint(canonical), preview: sample(canonical) };
}

const CONTEXT_API_ACTIONS = new Set([
  "sendMessage", "sendUserMessage", "setActiveTools", "setModel", "setThinkingLevel",
  "registerProvider", "unregisterProvider",
]);

function affectsContext(data: Record<string, unknown>): boolean {
  if (data.phase !== "exit") return false;
  if (data.surface === "hook") {
    return Boolean(data.mutation && (data.mutation as Record<string, unknown>).changed === true);
  }
  if (data.surface === "api") return CONTEXT_API_ACTIONS.has(String(data.action));
  if (data.surface === "context-api") {
    return ["compact", "navigateTree", "switchSession", "newSession", "fork", "reload"].includes(String(data.action));
  }
  return false;
}

function traceArgs(action: string, args: unknown[]): unknown {
  switch (action) {
    case "registerCommand": return { name: args[0] };
    case "registerShortcut": return { shortcut: args[0] };
    case "registerFlag": return { name: args[0], options: args[1] };
    case "registerMessageRenderer": return { customType: args[0] };
    case "registerEntryRenderer": return { customType: args[0] };
    case "registerMarkdownTransformer": return {};
    case "sendMessage": return { message: args[0], options: args[1] };
    case "sendUserMessage": return { content: args[0], options: args[1] };
    case "appendEntry": return { customType: args[0], data: args[1] };
    case "setSessionName": return { name: args[0] };
    case "setLabel": return { entryId: args[0], label: args[1] };
    case "setActiveTools": return { toolNames: args[0] };
    case "setModel": return { model: args[0] };
    case "setThinkingLevel": return { level: args[0] };
    case "registerTool": {
      const tool = args[0] as Record<string, unknown> | undefined;
      return { name: tool?.name, description: tool?.description, parameters: tool?.parameters };
    }
    case "registerProvider": return { name: typeof args[0] === "string" ? args[0] : (args[0] as Record<string, unknown> | undefined)?.name };
    case "unregisterProvider": return { name: args[0] };
    default: return args;
  }
}

const TRACED_ACTIONS = new Set([
  "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerMarkdownTransformer",
  "sendMessage", "sendUserMessage", "appendEntry", "setSessionName", "setLabel",
  "setActiveTools", "setModel", "setThinkingLevel", "registerProvider", "unregisterProvider",
]);

const CONTEXT_ACTIONS = new Set([
  "abort", "shutdown", "compact", "newSession", "fork", "navigateTree", "switchSession", "reload",
]);

function errorData(error: unknown): unknown {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
}

function scopedContext(ctx: unknown, packageName: string, recorder: UnipiTraceRecorder): unknown {
  if (!ctx || typeof ctx !== "object") return ctx;
  return new Proxy(ctx as Record<string, unknown>, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || !CONTEXT_ACTIONS.has(property) || typeof original !== "function") return original;
      return (...args: unknown[]) => {
        const started = performance.now();
        recorder.record({ package: packageName, surface: "context-api", phase: "enter", action: property, input: args });
        try {
          const result = original.apply(target, args);
          recorder.record({ package: packageName, surface: "context-api", phase: "exit", action: property, result: resultEvidence(result), durationMs: performance.now() - started });
          return result;
        } catch (error) {
          recorder.record({ package: packageName, surface: "context-api", phase: "error", action: property, durationMs: performance.now() - started, error: errorData(error) });
          throw error;
        }
      };
    },
  });
}

export function createUnipiTracer(pi: ExtensionAPI, sidecarRoot?: string): UnipiTracer {
  let sidecar: TelemetrySidecar | null = null;
  let sessionId: string | null = null;
  let traceSeq = 0;
  const recent: Array<{ seq: number; event: TelemetryEvent }> = [];
  const pending: Array<{ data: unknown; extra: Record<string, unknown>; at: number }> = [];
  const retain = (event: TelemetryEvent) => {
    recent.push({ seq: traceSeq++, event });
    if (recent.length > 2_000) recent.splice(0, recent.length - 2_000);
  };
  const persist = (data: unknown, extra: Record<string, unknown>, at: number) => {
    const event = { v: 1 as const, type: "unipi-trace" as const, at, ...extra, data };
    retain(event);
    sidecar?.append({ type: event.type, at: event.at, ...extra, data });
  };
  const recorder: UnipiTraceRecorder = {
    bind(nextSessionId) {
      if (sessionId === nextSessionId && sidecar) return;
      sessionId = nextSessionId;
      sidecar = new TelemetrySidecar(nextSessionId, sidecarRoot);
      recent.length = 0;
      traceSeq = 0;
      for (const event of pending.splice(0)) persist(event.data, event.extra, event.at);
    },
    record(data, extra = {}) {
      const tagged = data && typeof data === "object"
        ? { ...(data as Record<string, unknown>), affectsContext: affectsContext(data as Record<string, unknown>) }
        : data;
      if (!sidecar) {
        pending.push({ data: tagged, extra, at: Date.now() });
        return;
      }
      persist(tagged, extra, Date.now());
    },
    read() { return sidecar?.read() ?? []; },
    revision() { return sidecar?.revision() ?? traceSeq; },
    cursor() { return traceSeq; },
    since(cursor) { return recent.filter(item => item.seq >= cursor).map(item => item.event); },
  };
  const cache = new Map<string, ExtensionAPI>();

  return {
    recorder,
    scope(packageName) {
      const cached = cache.get(packageName);
      if (cached) return cached;
      const events = {
        emit(channel: string, data: unknown) {
          recorder.record({ package: packageName, surface: "event-bus", phase: "emit", channel, data });
          return pi.events.emit(channel, data);
        },
        on(channel: string, handler: (data: unknown) => void) {
          return pi.events.on(channel, (data) => {
            const started = performance.now();
            recorder.record({ package: packageName, surface: "event-bus", phase: "enter", channel, data });
            try {
              const result = (handler as (value: unknown) => unknown)(data);
              if (result && typeof result === "object" && "then" in result) {
                void Promise.resolve(result).then((value) => {
                  recorder.record({ package: packageName, surface: "event-bus", phase: "exit", channel, result: resultEvidence(value), durationMs: performance.now() - started });
                }, (error) => {
                  recorder.record({ package: packageName, surface: "event-bus", phase: "error", channel, durationMs: performance.now() - started, error: errorData(error) });
                });
              } else {
                recorder.record({ package: packageName, surface: "event-bus", phase: "exit", channel, result: resultEvidence(result), durationMs: performance.now() - started });
              }
            } catch (error) {
              recorder.record({ package: packageName, surface: "event-bus", phase: "error", channel, durationMs: performance.now() - started, error: errorData(error) });
              throw error;
            }
          });
        },
      };
      const scoped = new Proxy(pi as ExtensionAPI & Record<string, unknown>, {
        get(target, property, receiver) {
          if (property === "events") return events;
          const original = Reflect.get(target, property, receiver);
          if (property === "on" && typeof original === "function") {
            return (eventName: string, handler: (event: unknown, ctx: unknown) => unknown) => original.call(target, eventName, async (event: unknown, ctx: unknown) => {
              if (eventName === "session_start") {
                const sessionId = (ctx as { sessionManager?: { getSessionId?(): string } })?.sessionManager?.getSessionId?.();
                if (sessionId) recorder.bind(sessionId);
              }
              const started = performance.now();
              const before = canonicalize(mutationSurface(event));
              recorder.record({ package: packageName, surface: "hook", phase: "enter", hook: eventName, inputFingerprint: before === undefined ? undefined : fingerprint(before) });
              try {
                const result = await handler(event, scopedContext(ctx, packageName, recorder));
                const after = canonicalize(effectiveSurface(eventName, event, result));
                recorder.record({ package: packageName, surface: "hook", phase: "exit", hook: eventName, result: resultEvidence(result), mutation: mutationEvidence(before, after), durationMs: performance.now() - started });
                return result;
              } catch (error) {
                recorder.record({ package: packageName, surface: "hook", phase: "error", hook: eventName, durationMs: performance.now() - started, error: errorData(error) });
                throw error;
              }
            });
          }
          if (property === "registerTool" && typeof original === "function") {
            return (tool: Record<string, unknown>) => {
              const wrapped = typeof tool.execute === "function" ? {
                ...tool,
                execute: async (...args: unknown[]) => {
                  const started = performance.now();
                  recorder.record({ package: packageName, surface: "tool", phase: "enter", action: "execute", tool: tool.name, toolCallId: args[0], input: args[1] });
                  try {
                    const result = await (tool.execute as (...args: unknown[]) => unknown)(...args.slice(0, 4), scopedContext(args[4], packageName, recorder));
                    recorder.record({ package: packageName, surface: "tool", phase: "exit", action: "execute", tool: tool.name, toolCallId: args[0], result: resultEvidence(result), durationMs: performance.now() - started });
                    return result;
                  } catch (error) {
                    recorder.record({ package: packageName, surface: "tool", phase: "error", action: "execute", tool: tool.name, toolCallId: args[0], durationMs: performance.now() - started, error: errorData(error) });
                    throw error;
                  }
                },
              } : tool;
              recorder.record({ package: packageName, surface: "api", phase: "enter", action: property, input: traceArgs(property, [tool]) });
              const result = original.call(target, wrapped);
              recorder.record({ package: packageName, surface: "api", phase: "exit", action: property });
              return result;
            };
          }
          if (property === "registerCommand" && typeof original === "function") {
            return (name: string, options: Record<string, unknown>) => {
              const wrapped = typeof options.handler === "function" ? {
                ...options,
                handler: async (args: string, ctx: unknown) => {
                  const started = performance.now();
                  recorder.record({ package: packageName, surface: "command", phase: "enter", action: name, input: { args } });
                  try {
                    const result = await (options.handler as (args: string, ctx: unknown) => unknown)(args, scopedContext(ctx, packageName, recorder));
                    recorder.record({ package: packageName, surface: "command", phase: "exit", action: name, result: resultEvidence(result), durationMs: performance.now() - started });
                    return result;
                  } catch (error) {
                    recorder.record({ package: packageName, surface: "command", phase: "error", action: name, durationMs: performance.now() - started, error: errorData(error) });
                    throw error;
                  }
                },
              } : options;
              recorder.record({ package: packageName, surface: "api", phase: "enter", action: property, input: { name } });
              const result = original.call(target, name, wrapped);
              recorder.record({ package: packageName, surface: "api", phase: "exit", action: property });
              return result;
            };
          }
          if (property === "registerShortcut" && typeof original === "function") {
            return (shortcut: unknown, options: Record<string, unknown>) => original.call(target, shortcut, typeof options.handler === "function" ? {
              ...options,
              handler: async (ctx: unknown) => {
                const started = performance.now();
                recorder.record({ package: packageName, surface: "shortcut", phase: "enter", action: String(shortcut) });
                try {
                  const result = await (options.handler as (ctx: unknown) => unknown)(scopedContext(ctx, packageName, recorder));
                  recorder.record({ package: packageName, surface: "shortcut", phase: "exit", action: String(shortcut), result: resultEvidence(result), durationMs: performance.now() - started });
                  return result;
                } catch (error) {
                  recorder.record({ package: packageName, surface: "shortcut", phase: "error", action: String(shortcut), durationMs: performance.now() - started, error: errorData(error) });
                  throw error;
                }
              },
            } : options);
          }
          if (typeof property === "string" && TRACED_ACTIONS.has(property) && typeof original === "function") {
            return (...args: unknown[]) => {
              const started = performance.now();
              recorder.record({ package: packageName, surface: "api", phase: "enter", action: property, input: traceArgs(property, args) });
              try {
                const result = original.apply(target, args);
                if (result && typeof result === "object" && "then" in result) {
                  return Promise.resolve(result).then((value) => {
                    recorder.record({ package: packageName, surface: "api", phase: "exit", action: property, result: value, durationMs: performance.now() - started });
                    return value;
                  }, (error) => {
                    recorder.record({ package: packageName, surface: "api", phase: "error", action: property, durationMs: performance.now() - started, error: errorData(error) });
                    throw error;
                  });
                }
                recorder.record({ package: packageName, surface: "api", phase: "exit", action: property, result, durationMs: performance.now() - started });
                return result;
              } catch (error) {
                recorder.record({ package: packageName, surface: "api", phase: "error", action: property, durationMs: performance.now() - started, error: errorData(error) });
                throw error;
              }
            };
          }
          return typeof original === "function" ? original.bind(target) : original;
        },
      }) as ExtensionAPI;
      cache.set(packageName, scoped);
      return scoped;
    },
  };
}
