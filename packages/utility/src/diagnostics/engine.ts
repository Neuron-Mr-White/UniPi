/**
 * @pi-unipi/utility — Diagnostics Engine
 *
 * Cross-module diagnostics runner with health check plugins.
 */

import { existsSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  DiagnosticCheck,
  DiagnosticPlugin,
  DiagnosticsReport,
  HealthStatus,
} from "../types.js";

/** Expand ~ to home directory */
function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Check if a path is readable */
function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Check if a path is writable */
function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ─── Built-in Diagnostic Plugins ─────────────────────────────────────────────

/** Check core directories exist and are accessible */
const coreDirectoriesPlugin: DiagnosticPlugin = {
  name: "core_directories",
  module: "@pi-unipi/core",
  async run(): Promise<DiagnosticCheck[]> {
    const dirs = [
      { path: "~/.unipi", required: true },
      { path: "~/.unipi/memory", required: false },
      { path: "~/.unipi/cache", required: false },
      { path: "~/.unipi/analytics", required: false },
    ];

    const checks: DiagnosticCheck[] = [];
    const start = Date.now();

    for (const dir of dirs) {
      const fullPath = expandHome(dir.path);
      const exists = existsSync(fullPath);
      const readable = exists && isReadable(fullPath);
      const writable = exists && isWritable(fullPath);

      let status: HealthStatus;
      let message: string;
      let suggestion: string | undefined;

      if (!exists) {
        if (dir.required) {
          status = "error";
          message = `Required directory missing: ${dir.path}`;
          suggestion = `Create it: mkdir -p ${dir.path}`;
        } else {
          status = "warning";
          message = `Optional directory missing: ${dir.path}`;
          suggestion = `Create it if needed: mkdir -p ${dir.path}`;
        }
      } else if (!writable) {
        status = "error";
        message = `Directory not writable: ${dir.path}`;
        suggestion = `Check permissions: chmod u+w ${dir.path}`;
      } else {
        status = "healthy";
        message = `Directory OK: ${dir.path}`;
      }

      checks.push({
        name: `dir_${dir.path.replace(/[^a-z0-9]/g, "_")}`,
        module: "@pi-unipi/core",
        status,
        message,
        suggestion,
        durationMs: Date.now() - start,
      });
    }

    return checks;
  },
};

/** Check config files are valid JSON */
const configFilesPlugin: DiagnosticPlugin = {
  name: "config_files",
  module: "@pi-unipi/core",
  async run(): Promise<DiagnosticCheck[]> {
    const configs = [
      "~/.unipi/config/mcp/servers.json",
      ".unipi/config/mcp/servers.json",
    ];

    const checks: DiagnosticCheck[] = [];

    for (const configPath of configs) {
      const start = Date.now();
      const fullPath = expandHome(configPath);

      if (!existsSync(fullPath)) {
        checks.push({
          name: `config_${basename(configPath)}`,
          module: "@pi-unipi/core",
          status: "unknown",
          message: `Config not found: ${configPath}`,
          durationMs: Date.now() - start,
        });
        continue;
      }

      try {
        const content = await import("node:fs").then((fs) =>
          fs.readFileSync(fullPath, "utf-8"),
        );
        JSON.parse(content);
        checks.push({
          name: `config_${basename(configPath)}`,
          module: "@pi-unipi/core",
          status: "healthy",
          message: `Config valid: ${configPath}`,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        checks.push({
          name: `config_${basename(configPath)}`,
          module: "@pi-unipi/core",
          status: "error",
          message: `Invalid JSON in ${configPath}: ${(err as Error).message}`,
          suggestion: `Fix or remove the config file`,
          durationMs: Date.now() - start,
        });
      }
    }

    return checks;
  },
};

/** Check Node.js environment */
const nodeEnvironmentPlugin: DiagnosticPlugin = {
  name: "node_environment",
  module: "@pi-unipi/core",
  async run(): Promise<DiagnosticCheck[]> {
    const start = Date.now();
    const checks: DiagnosticCheck[] = [];

    // Node version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
    const nodeCheck: DiagnosticCheck = {
      name: "node_version",
      module: "@pi-unipi/core",
      status: major >= 18 ? "healthy" : "warning",
      message: `Node.js ${nodeVersion}`,
      suggestion: major < 18 ? "Upgrade to Node.js 18+ for best compatibility" : undefined,
      durationMs: Date.now() - start,
    };
    checks.push(nodeCheck);

    // Memory usage
    const memStart = Date.now();
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    checks.push({
      name: "memory_usage",
      module: "@pi-unipi/core",
      status: heapUsedMB > 512 ? "warning" : "healthy",
      message: `Heap: ${heapUsedMB} MB / ${heapTotalMB} MB`,
      suggestion: heapUsedMB > 512 ? "High memory usage detected — consider restarting" : undefined,
      durationMs: Date.now() - memStart,
    });

    return checks;
  },
};

// ─── Diagnostics Engine ──────────────────────────────────────────────────────

/** Registry of diagnostic plugins */
const plugins: DiagnosticPlugin[] = [
  coreDirectoriesPlugin,
  configFilesPlugin,
  nodeEnvironmentPlugin,
];

/** Register a custom diagnostic plugin */
export function registerDiagnosticPlugin(plugin: DiagnosticPlugin): void {
  plugins.push(plugin);
}

/** Run all diagnostic checks and generate a report */
export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const timestamp = Date.now();
  const checks: DiagnosticCheck[] = [];

  for (const plugin of plugins) {
    try {
      const pluginChecks = await plugin.run();
      checks.push(...pluginChecks);
    } catch (err) {
      checks.push({
        name: `${plugin.name}_error`,
        module: plugin.module,
        status: "error",
        message: `Plugin failed: ${(err as Error).message}`,
        durationMs: 0,
      });
    }
  }

  const summary = {
    healthy: checks.filter((c) => c.status === "healthy").length,
    warning: checks.filter((c) => c.status === "warning").length,
    error: checks.filter((c) => c.status === "error").length,
    unknown: checks.filter((c) => c.status === "unknown").length,
  };

  let overall: HealthStatus;
  if (summary.error > 0) {
    overall = "error";
  } else if (summary.warning > 0) {
    overall = "warning";
  } else if (summary.healthy > 0) {
    overall = "healthy";
  } else {
    overall = "unknown";
  }

  return {
    timestamp,
    overall,
    checks,
    summary,
  };
}

/** Format a diagnostics report as markdown */
export function formatDiagnosticsReport(report: DiagnosticsReport): string {
  const lines = [
    "## 🔍 Diagnostics Report",
    "",
    `**Overall:** ${report.overall.toUpperCase()}`,
    `**Checks:** ${report.summary.healthy} healthy, ${report.summary.warning} warning, ${report.summary.error} error, ${report.summary.unknown} unknown`,
    `**Timestamp:** ${new Date(report.timestamp).toISOString()}`,
    "",
  ];

  // Group by status (errors first)
  const byStatus = {
    error: report.checks.filter((c) => c.status === "error"),
    warning: report.checks.filter((c) => c.status === "warning"),
    unknown: report.checks.filter((c) => c.status === "unknown"),
    healthy: report.checks.filter((c) => c.status === "healthy"),
  };

  for (const [status, checks] of Object.entries(byStatus)) {
    if (checks.length === 0) continue;
    lines.push(`### ${status.toUpperCase()} (${checks.length})`, "");
    for (const check of checks) {
      lines.push(`- **${check.name}** (${check.module})`);
      lines.push(`  ${check.message}`);
      if (check.suggestion) {
        lines.push(`  💡 ${check.suggestion}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Get basename for diagnostic naming */
function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}
