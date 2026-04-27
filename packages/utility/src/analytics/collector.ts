/**
 * @pi-unipi/utility — Analytics Collector
 *
 * Lightweight metrics collection for all unipi modules.
 * Privacy-respecting: no file contents, no sensitive data.
 */

import { randomUUID } from "node:crypto";
import type {
  AnalyticsEvent,
  AnalyticsEventType,
  AnalyticsRollup,
  AnalyticsOptions,
} from "../types.js";

/** Default options */
const DEFAULTS: Required<AnalyticsOptions> = {
  dbPath: "~/.unipi/analytics/events.db",
  maxEvents: 10000,
  rollupEnabled: true,
};

/** In-memory event buffer */
const eventBuffer: AnalyticsEvent[] = [];
let bufferFlushTimer: ReturnType<typeof setInterval> | null = null;

/** Generate a unique event ID */
function generateId(): string {
  return randomUUID();
}

/** Get today's date as YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * AnalyticsCollector records events and provides rollup aggregation.
 * Uses in-memory buffering with periodic flush to avoid I/O overhead.
 */
export class AnalyticsCollector {
  private opts: Required<AnalyticsOptions>;
  private enabled: boolean;

  constructor(options: AnalyticsOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.enabled = true;
    this.startFlushTimer();
  }

  /** Disable collection */
  disable(): void {
    this.enabled = false;
    this.stopFlushTimer();
  }

  /** Enable collection */
  enable(): void {
    this.enabled = true;
    this.startFlushTimer();
  }

  /** Record an analytics event */
  record(
    type: AnalyticsEventType,
    metadata?: Record<string, unknown>,
  ): AnalyticsEvent {
    if (!this.enabled) {
      return {
        id: generateId(),
        type,
        timestamp: Date.now(),
        metadata,
      };
    }

    const event: AnalyticsEvent = {
      id: generateId(),
      type,
      timestamp: Date.now(),
      metadata: this.sanitizeMetadata(metadata),
    };

    eventBuffer.push(event);

    // Auto-flush if buffer is full
    if (eventBuffer.length >= this.opts.maxEvents) {
      this.flush().catch(() => {
        // Best-effort flush
      });
    }

    return event;
  }

  /** Record a command execution */
  recordCommand(
    command: string,
    module: string,
    durationMs: number,
    success: boolean,
  ): AnalyticsEvent {
    return this.record("command_run", {
      command,
      module,
      durationMs,
      success,
    });
  }

  /** Record a tool call */
  recordTool(
    tool: string,
    module: string,
    durationMs: number,
    success: boolean,
  ): AnalyticsEvent {
    return this.record("tool_call", {
      tool,
      module,
      durationMs,
      success,
    });
  }

  /** Record an error */
  recordError(
    module: string,
    errorType: string,
    message?: string,
  ): AnalyticsEvent {
    return this.record("error", {
      module,
      errorType,
      message: message ? this.sanitizeString(message) : undefined,
    });
  }

  /** Record a module load */
  recordModuleLoad(module: string, version: string): AnalyticsEvent {
    return this.record("module_load", { module, version });
  }

  /** Record a search operation */
  recordSearch(
    module: string,
    query: string,
    resultCount: number,
  ): AnalyticsEvent {
    return this.record("search", {
      module,
      query: this.sanitizeString(query),
      resultCount,
    });
  }

  /** Get all buffered events */
  getEvents(): readonly AnalyticsEvent[] {
    return eventBuffer;
  }

  /** Get events filtered by type */
  getEventsByType(type: AnalyticsEventType): AnalyticsEvent[] {
    return eventBuffer.filter((e) => e.type === type);
  }

  /** Compute daily rollup from buffered events */
  getRollup(date?: string): AnalyticsRollup {
    const targetDate = date ?? today();
    const dayStart = new Date(targetDate).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const dayEvents = eventBuffer.filter(
      (e) => e.timestamp >= dayStart && e.timestamp < dayEnd,
    );

    const events: Record<AnalyticsEventType, number> = {
      module_load: 0,
      command_run: 0,
      tool_call: 0,
      error: 0,
      compaction: 0,
      search: 0,
    };

    let totalDurationMs = 0;
    let errorCount = 0;

    for (const e of dayEvents) {
      events[e.type]++;
      if (e.metadata?.durationMs) {
        totalDurationMs += Number(e.metadata.durationMs);
      }
      if (e.type === "error" || e.metadata?.success === false) {
        errorCount++;
      }
    }

    return {
      date: targetDate,
      events,
      totalDurationMs,
      errorCount,
    };
  }

  /** Export all events to JSON */
  exportToJSON(): string {
    return JSON.stringify(eventBuffer, null, 2);
  }

  /** Flush buffered events to storage (placeholder for future SQLite persistence) */
  async flush(): Promise<number> {
    const count = eventBuffer.length;
    // TODO: persist to SQLite when sqlite3 is available
    // For now, keep in memory but trim if over max
    if (count > this.opts.maxEvents) {
      eventBuffer.splice(0, count - this.opts.maxEvents);
    }
    return count;
  }

  /** Clear all buffered events */
  clear(): void {
    eventBuffer.length = 0;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private startFlushTimer(): void {
    if (bufferFlushTimer) return;
    bufferFlushTimer = setInterval(() => {
      this.flush().catch(() => {
        // Best-effort
      });
    }, 60000); // Flush every minute
    if (bufferFlushTimer.unref) {
      bufferFlushTimer.unref();
    }
  }

  private stopFlushTimer(): void {
    if (bufferFlushTimer) {
      clearInterval(bufferFlushTimer);
      bufferFlushTimer = null;
    }
  }

  /** Sensitive key patterns to redact */
  private static SENSITIVE_KEYS =
    /api[_-]?key|apiKey|token|password|secret|auth|credential|private[_-]?key/i;

  /** Remove sensitive data from metadata */
  private sanitizeMetadata(
    metadata?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!metadata) return undefined;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (AnalyticsCollector.SENSITIVE_KEYS.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        sanitized[key] = this.sanitizeString(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /** Truncate long strings, remove potential secrets */
  private sanitizeString(str: string): string {
    // Truncate to 500 chars
    let result = str.length > 500 ? str.slice(0, 500) + "…" : str;
    // Redact common secret patterns in strings
    result = result.replace(
      /(api[_-]?key|apiKey|token|password|secret|auth)\s*[:=]\s*\S+/gi,
      "$1: [REDACTED]",
    );
    return result;
  }
}

/** Global singleton */
let globalCollector: AnalyticsCollector | null = null;

/** Get or create the global analytics collector */
export function getAnalyticsCollector(options?: AnalyticsOptions): AnalyticsCollector {
  if (!globalCollector) {
    globalCollector = new AnalyticsCollector(options);
  }
  return globalCollector;
}
