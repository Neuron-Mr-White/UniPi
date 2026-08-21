import type { EventBus } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_LOG_BYTES,
  normalizeMaxBytes,
  type BgLogsDetails,
  type BgTaskSnapshot,
  type JsonObject,
  type StartTaskOptions,
} from './types.js';
import type { BackgroundTaskContext, BackgroundTaskRegistry } from './registry.js';

export const BG_REQUEST_CHANNEL = 'unipi-background-tasks:request:v1';
export const BG_RESPONSE_CHANNEL = 'unipi-background-tasks:response:v1';
export const BG_TERMINAL_CHANNEL = 'unipi-background-tasks:terminal:v1';
export const BG_REQUEST_SCHEMA = 'unipi-background-tasks.extension-request.v1';
export const BG_RESPONSE_SCHEMA = 'unipi-background-tasks.extension-response.v1';
export const BG_TERMINAL_SCHEMA = 'unipi-background-tasks.extension-terminal.v1';

const MAX_ERROR_CHARS = 240;
const MAX_REQUEST_ID_CHARS = 200;

export type BackgroundTaskExtensionOperation = 'capabilities' | 'run' | 'status' | 'logs' | 'kill';

export interface BackgroundTaskExtensionCapabilities {
  api_version: 1;
  run: boolean;
  run_is_agent: boolean;
  run_completion_trigger: boolean;
  status: boolean;
  logs: boolean;
  logs_bounded: boolean;
  kill: boolean;
}

export const BG_EXTENSION_CAPABILITIES: BackgroundTaskExtensionCapabilities = Object.freeze({
  api_version: 1,
  run: true,
  run_is_agent: true,
  run_completion_trigger: true,
  status: true,
  logs: true,
  logs_bounded: true,
  kill: true,
});

export interface BackgroundTaskExtensionRunPayload {
  name: string;
  command: string;
  isAgent: boolean;
  timeoutSeconds?: number | undefined;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
}

export interface BackgroundTaskExtensionStatusPayload {
  taskId?: string | undefined;
}

export interface BackgroundTaskExtensionLogsPayload {
  taskId: string;
  maxBytes?: number | undefined;
  tail?: boolean | undefined;
}

export interface BackgroundTaskExtensionKillPayload {
  taskId: string;
}

export type BackgroundTaskExtensionPayload =
  | Record<PropertyKey, never>
  | BackgroundTaskExtensionRunPayload
  | BackgroundTaskExtensionStatusPayload
  | BackgroundTaskExtensionLogsPayload
  | BackgroundTaskExtensionKillPayload;

export interface BackgroundTaskExtensionRequest {
  schema_version: typeof BG_REQUEST_SCHEMA;
  request_id: string;
  operation: BackgroundTaskExtensionOperation;
  payload: BackgroundTaskExtensionPayload;
}

export type BackgroundTaskExtensionResult =
  | BackgroundTaskExtensionCapabilities
  | BgTaskSnapshot
  | { tasks: BgTaskSnapshot[] }
  | (BgLogsDetails & { text: string })
  | { task: BgTaskSnapshot; message: string };

export type BackgroundTaskExtensionResponse =
  | {
      schema_version: typeof BG_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: true;
      result: BackgroundTaskExtensionResult;
    }
  | {
      schema_version: typeof BG_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: false;
      error: string;
    };

export interface BackgroundTaskExtensionTerminal {
  schema_version: typeof BG_TERMINAL_SCHEMA;
  task: BgTaskSnapshot;
}

export interface BackgroundTaskExtensionService {
  publishTerminal(task: BgTaskSnapshot): void;
  close(): void;
}

export interface BackgroundTaskExtensionServiceOptions {
  events: EventBus;
  registry: BackgroundTaskRegistry;
  getContext: () => BackgroundTaskContext | undefined;
  isShuttingDown: () => boolean;
  logger?: Pick<Console, 'error'> | undefined;
}

type JsonRecord = JsonObject;

interface ParsedRequest {
  requestId: string;
  operationEcho: string;
  request?: BackgroundTaskExtensionRequest | undefined;
  error?: string | undefined;
}

interface TerminalPublicationGate {
  promise: Promise<void>;
  releaseAfterResponse(): Promise<void>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertClosed(record: JsonRecord, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireOperation(value: unknown, label: string): BackgroundTaskExtensionOperation {
  if (
    value === 'capabilities' ||
    value === 'run' ||
    value === 'status' ||
    value === 'logs' ||
    value === 'kill'
  ) {
    return value;
  }
  throw new Error(`${label} must be one of capabilities, run, status, logs, kill`);
}

function operationEcho(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'malformed';
}

function requestIdEcho(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'malformed';
}

function parseCapabilitiesPayload(value: unknown): Record<PropertyKey, never> {
  const payload = requireRecord(value, 'capabilities.payload');
  assertClosed(payload, [], 'capabilities.payload');
  return {};
}

function parseRunPayload(value: unknown): BackgroundTaskExtensionRunPayload {
  const payload = requireRecord(value, 'run.payload');
  assertClosed(
    payload,
    ['name', 'command', 'isAgent', 'timeoutSeconds', 'notifyOnCompletion', 'triggerOnCompletion'],
    'run.payload',
  );
  const out: BackgroundTaskExtensionRunPayload = {
    name: requireNonEmptyString(payload['name'], 'run.payload.name'),
    command: requireNonEmptyString(payload['command'], 'run.payload.command'),
    isAgent: requireBoolean(payload['isAgent'], 'run.payload.isAgent'),
    notifyOnCompletion: requireBoolean(
      payload['notifyOnCompletion'],
      'run.payload.notifyOnCompletion',
    ),
    triggerOnCompletion: requireBoolean(
      payload['triggerOnCompletion'],
      'run.payload.triggerOnCompletion',
    ),
  };
  if (hasOwn(payload, 'timeoutSeconds')) {
    out.timeoutSeconds = requirePositiveInteger(
      payload['timeoutSeconds'],
      'run.payload.timeoutSeconds',
    );
  }
  return out;
}

function parseStatusPayload(value: unknown): BackgroundTaskExtensionStatusPayload {
  const payload = requireRecord(value, 'status.payload');
  assertClosed(payload, ['taskId'], 'status.payload');
  const out: BackgroundTaskExtensionStatusPayload = {};
  if (hasOwn(payload, 'taskId')) {
    out.taskId = requireNonEmptyString(payload['taskId'], 'status.payload.taskId');
  }
  return out;
}

function parseLogsPayload(value: unknown): BackgroundTaskExtensionLogsPayload {
  const payload = requireRecord(value, 'logs.payload');
  assertClosed(payload, ['taskId', 'maxBytes', 'tail'], 'logs.payload');
  const out: BackgroundTaskExtensionLogsPayload = {
    taskId: requireNonEmptyString(payload['taskId'], 'logs.payload.taskId'),
  };
  if (hasOwn(payload, 'maxBytes')) {
    out.maxBytes = requirePositiveInteger(payload['maxBytes'], 'logs.payload.maxBytes');
  }
  if (hasOwn(payload, 'tail')) out.tail = requireBoolean(payload['tail'], 'logs.payload.tail');
  return out;
}

function parseKillPayload(value: unknown): BackgroundTaskExtensionKillPayload {
  const payload = requireRecord(value, 'kill.payload');
  assertClosed(payload, ['taskId'], 'kill.payload');
  return { taskId: requireNonEmptyString(payload['taskId'], 'kill.payload.taskId') };
}

function parsePayload(
  operation: BackgroundTaskExtensionOperation,
  value: unknown,
): BackgroundTaskExtensionPayload {
  switch (operation) {
    case 'capabilities':
      return parseCapabilitiesPayload(value);
    case 'run':
      return parseRunPayload(value);
    case 'status':
      return parseStatusPayload(value);
    case 'logs':
      return parseLogsPayload(value);
    case 'kill':
      return parseKillPayload(value);
  }
}

function parseRequest(data: unknown): ParsedRequest {
  if (!isRecord(data)) {
    return {
      requestId: 'malformed',
      operationEcho: 'malformed',
      error: 'request frame must be an object',
    };
  }
  const requestId = requestIdEcho(data['request_id']);
  const opEcho = operationEcho(data['operation']);
  try {
    assertClosed(data, ['schema_version', 'request_id', 'operation', 'payload'], 'request');
    if (data['schema_version'] !== BG_REQUEST_SCHEMA)
      throw new Error('request schema_version mismatch');
    const parsedRequestId = requireNonEmptyString(data['request_id'], 'request.request_id');
    if (parsedRequestId.length > MAX_REQUEST_ID_CHARS) {
      throw new Error(
        `request.request_id must be at most ${String(MAX_REQUEST_ID_CHARS)} characters`,
      );
    }
    const operation = requireOperation(data['operation'], 'request.operation');
    if (!hasOwn(data, 'payload')) throw new Error('request.payload is required');
    const payload = parsePayload(operation, data['payload']);
    return {
      requestId: parsedRequestId,
      operationEcho: operation,
      request: {
        schema_version: BG_REQUEST_SCHEMA,
        request_id: parsedRequestId,
        operation,
        payload,
      },
    };
  } catch (error) {
    return { requestId, operationEcho: opEcho, error: errorText(error) };
  }
}

function createTerminalPublicationGate(): TerminalPublicationGate {
  let released = false;
  let resolveGate: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  return {
    promise,
    async releaseAfterResponse() {
      if (released) return;
      released = true;
      // Give response listeners one microtask turn to resolve their request promises
      // and bind the returned task id before an early terminal event is emitted.
      await Promise.resolve();
      resolveGate();
    },
  };
}

function combineTerminalPublicationGates(
  existing: Promise<void> | undefined,
  next: Promise<void> | undefined,
): Promise<void> | undefined {
  if (existing === undefined) return next;
  if (next === undefined) return existing;
  return Promise.all([existing, next]).then(() => undefined);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedBackgroundTaskError(error: unknown): string {
  const text = errorText(error).replace(/\s+/gu, ' ').trim();
  if (text.length <= MAX_ERROR_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function errorResponse(
  requestId: string,
  operation: string,
  error: unknown,
): BackgroundTaskExtensionResponse {
  return {
    schema_version: BG_RESPONSE_SCHEMA,
    request_id: requestId,
    operation,
    ok: false,
    error: boundedBackgroundTaskError(error),
  };
}

function successResponse(
  request: BackgroundTaskExtensionRequest,
  result: BackgroundTaskExtensionResult,
): BackgroundTaskExtensionResponse {
  return {
    schema_version: BG_RESPONSE_SCHEMA,
    request_id: request.request_id,
    operation: request.operation,
    ok: true,
    result,
  };
}

function runPayload(value: BackgroundTaskExtensionPayload): BackgroundTaskExtensionRunPayload {
  return value as BackgroundTaskExtensionRunPayload;
}

function statusPayload(
  value: BackgroundTaskExtensionPayload,
): BackgroundTaskExtensionStatusPayload {
  return value as BackgroundTaskExtensionStatusPayload;
}

function logsPayload(value: BackgroundTaskExtensionPayload): BackgroundTaskExtensionLogsPayload {
  return value as BackgroundTaskExtensionLogsPayload;
}

function killPayload(value: BackgroundTaskExtensionPayload): BackgroundTaskExtensionKillPayload {
  return value as BackgroundTaskExtensionKillPayload;
}

class InstalledBackgroundTaskExtensionService implements BackgroundTaskExtensionService {
  private readonly events: EventBus;
  private readonly registry: BackgroundTaskRegistry;
  private readonly getContext: () => BackgroundTaskContext | undefined;
  private readonly isShuttingDown: () => boolean;
  private readonly logger: Pick<Console, 'error'>;
  private readonly seenRequestIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: BackgroundTaskExtensionServiceOptions) {
    this.events = options.events;
    this.registry = options.registry;
    this.getContext = options.getContext;
    this.isShuttingDown = options.isShuttingDown;
    this.logger = options.logger ?? console;
    this.unsubscribe = this.events.on(BG_REQUEST_CHANNEL, (data) => {
      void this.handle(data);
    });
  }

  publishTerminal(task: BgTaskSnapshot): void {
    if (this.closed) throw new Error('unipi-background-tasks EventBus service is closed');
    const terminal: BackgroundTaskExtensionTerminal = {
      schema_version: BG_TERMINAL_SCHEMA,
      task,
    };
    this.events.emit(BG_TERMINAL_CHANNEL, terminal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
  }

  private async handle(data: unknown): Promise<void> {
    const parsed = parseRequest(data);
    if (parsed.error !== undefined || parsed.request === undefined) {
      this.emitResponse(
        errorResponse(parsed.requestId, parsed.operationEcho, parsed.error ?? 'malformed request'),
      );
      return;
    }
    const request = parsed.request;
    if (this.seenRequestIds.has(request.request_id)) {
      this.emitResponse(
        errorResponse(
          request.request_id,
          request.operation,
          `duplicate request_id ${request.request_id}`,
        ),
      );
      return;
    }
    this.seenRequestIds.add(request.request_id);
    const terminalGate =
      request.operation === 'run' || request.operation === 'kill'
        ? createTerminalPublicationGate()
        : undefined;
    try {
      if (this.closed) throw new Error('unipi-background-tasks EventBus service is closed');
      if (this.isShuttingDown() || this.registry.isShuttingDown()) {
        throw new Error('unipi-background-tasks EventBus service is shutting down');
      }
      const ctx = this.getContext();
      if (ctx === undefined) {
        throw new Error('unipi-background-tasks EventBus service is unavailable before session_start');
      }
      this.emitResponse(
        successResponse(request, await this.execute(ctx, request, terminalGate?.promise)),
      );
    } catch (error) {
      this.emitResponse(errorResponse(request.request_id, request.operation, error));
    } finally {
      await terminalGate?.releaseAfterResponse();
    }
  }

  private async execute(
    ctx: BackgroundTaskContext,
    request: BackgroundTaskExtensionRequest,
    terminalPublicationGate?: Promise<void> | undefined,
  ): Promise<BackgroundTaskExtensionResult> {
    switch (request.operation) {
      case 'capabilities':
        return { ...BG_EXTENSION_CAPABILITIES };
      case 'run': {
        const payload = runPayload(request.payload);
        const options: StartTaskOptions = {
          name: payload.name,
          isAgent: payload.isAgent,
          notifyOnCompletion: payload.notifyOnCompletion,
          triggerOnCompletion: payload.triggerOnCompletion,
          terminalPublicationGate,
        };
        if (payload.timeoutSeconds !== undefined) options.timeoutSeconds = payload.timeoutSeconds;
        const task = await this.registry.startTask(ctx, payload.command, options);
        return this.registry.snapshot(task);
      }
      case 'status': {
        const payload = statusPayload(request.payload);
        const tasks = payload.taskId
          ? [this.registry.resolveTask(payload.taskId)]
          : this.registry.allTasks();
        return { tasks: tasks.map((task) => this.registry.snapshot(task)) };
      }
      case 'logs': {
        const payload = logsPayload(request.payload);
        const task = this.registry.resolveTask(payload.taskId);
        const logs = await this.registry.getTaskLogs(
          task,
          normalizeMaxBytes(payload.maxBytes, DEFAULT_LOG_BYTES),
          payload.tail ?? true,
        );
        return { ...logs.details, text: logs.text };
      }
      case 'kill': {
        const payload = killPayload(request.payload);
        const task = this.registry.resolveTask(payload.taskId);
        task.terminalPublicationGate = combineTerminalPublicationGates(
          task.terminalPublicationGate,
          terminalPublicationGate,
        );
        await this.registry.stopTask(task, 'user');
        const snapshot = this.registry.snapshot(task);
        return {
          task: snapshot,
          message: `Killed background task ${snapshot.name ?? snapshot.id} (${snapshot.id}). Output: ${snapshot.outputPath}`,
        };
      }
    }
  }

  private emitResponse(response: BackgroundTaskExtensionResponse): void {
    try {
      this.events.emit(BG_RESPONSE_CHANNEL, response);
    } catch (error) {
      this.logger.error('[background-tasks] EventBus response emit failed:', error);
    }
  }
}

export function installBackgroundTaskExtensionApi(
  options: BackgroundTaskExtensionServiceOptions,
): BackgroundTaskExtensionService {
  return new InstalledBackgroundTaskExtensionService(options);
}
