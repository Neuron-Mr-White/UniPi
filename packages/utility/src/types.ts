/**
 * @pi-unipi/utility — Shared types (diagnostics)
 */

/** Health status for a single check */
export type HealthStatus = "healthy" | "warning" | "error" | "unknown";

/** Result of a single diagnostic check */
export interface DiagnosticCheck {
  name: string;
  module: string;
  status: HealthStatus;
  message: string;
  suggestion?: string;
  durationMs: number;
}

/** Complete diagnostics report */
export interface DiagnosticsReport {
  timestamp: number;
  overall: HealthStatus;
  checks: DiagnosticCheck[];
  summary: {
    healthy: number;
    warning: number;
    error: number;
    unknown: number;
  };
}

/** Plugin for diagnostics engine */
export interface DiagnosticPlugin {
  name: string;
  module: string;
  run(): Promise<DiagnosticCheck[]>;
}
