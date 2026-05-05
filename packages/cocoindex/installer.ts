/**
 * installer.ts — Consent-based CocoIndex CLI installer helpers.
 *
 * Pure planning helpers are separated from side-effecting execution so command
 * handlers can show the exact install plan before running anything.
 */

import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { COCOINDEX_PACKAGE_SPEC } from "@pi-unipi/core";

export type SupportedShell = "bash" | "zsh" | "fish" | "unknown";
export type InstallPlanKind = "auto" | "manual";

export interface InstallStep {
  /** Executable name/path. */
  command: string;
  /** Argv passed to the executable. Prefer this over shell strings. */
  args?: string[];
  /** User-facing command display for consent/errors. */
  displayCommand: string;
  /** User-facing description of the step. */
  description: string;
  /** Optional steps may fail without aborting the whole plan. */
  optional?: boolean;
  /** Timeout for this step. Defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface InstallPlan {
  kind: InstallPlanKind;
  steps: InstallStep[];
  summary: string;
  shell: SupportedShell;
  manualInstructions?: string[];
}

export interface InstallResult {
  ok: boolean;
  binPath?: string;
  version?: string;
  error?: string;
  skipped?: boolean;
  stdout?: string;
  stderr?: string;
  failedStep?: InstallStep;
  manualInstructions?: string[];
}

export type InstallProgress = (message: string, step?: InstallStep) => void;

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** Detect the user's login shell for shell-aware manual instructions. */
export function detectShell(): SupportedShell {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("fish")) return "fish";
  return "unknown";
}

/** Safely check whether a command is on PATH. */
export function hasTool(name: string): boolean {
  // Defend against accidental shell metacharacters even though the name is
  // supplied internally today.
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return false;

  try {
    const result = execFileSync("sh", ["-c", "command -v -- \"$1\"", "sh", name], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
      env: installerEnv(),
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/** Compute an install plan without executing any commands. */
export function dryRun(): InstallPlan {
  const shell = detectShell();

  if (hasTool("uv")) {
    return automaticPlan(shell, [uvInstallStep()]);
  }

  if (hasTool("mise")) {
    return automaticPlan(shell, [
      {
        command: "mise",
        args: ["use", "-g", "uv@latest"],
        displayCommand: "mise use -g uv@latest",
        description: "Install and activate uv with mise",
      },
      uvInstallStep(),
    ]);
  }

  const manualInstructions = buildManualInstructions(shell);
  return {
    kind: "manual",
    steps: [],
    shell,
    manualInstructions,
    summary: [
      "CocoIndex CLI is not installed, and neither uv nor mise was found on PATH.",
      "",
      ...manualInstructions,
    ].join("\n"),
  };
}

/** Execute an automatic install plan sequentially. */
export async function execute(plan: InstallPlan, onProgress?: InstallProgress): Promise<InstallResult> {
  if (plan.kind === "manual") {
    return {
      ok: false,
      error: "Manual CocoIndex installation is required.",
      manualInstructions: plan.manualInstructions,
    };
  }

  for (const step of plan.steps) {
    onProgress?.(step.description, step);
    const result = await runStep(step);

    if (result.ok) continue;
    if (step.optional) continue;

    const isMiseStep = step.command === "mise";
    const manualInstructions = isMiseStep ? buildUvInstallerFallback(plan.shell) : undefined;
    const fallback = manualInstructions
      ? `\n\nFallback uv installer:\n${manualInstructions.join("\n")}`
      : "";

    return {
      ok: false,
      error: `Install step failed: ${step.displayCommand}\n${summarizeCommandOutput(result)}${fallback}`,
      stdout: result.stdout,
      stderr: result.stderr,
      failedStep: step,
      manualInstructions,
    };
  }

  return { ok: true };
}

function automaticPlan(shell: SupportedShell, steps: InstallStep[]): InstallPlan {
  const commandLines = steps.map((step) => `  • ${step.displayCommand}`);
  return {
    kind: "auto",
    steps,
    shell,
    summary: [
      "Pi can install CocoIndex CLI with LanceDB support for this user account.",
      "",
      `Package: ${COCOINDEX_PACKAGE_SPEC}`,
      "Commands to run:",
      ...commandLines,
      "",
      "This uses isolated uv tool environments and exposes the `cocoindex` binary under ~/.local/bin/.",
    ].join("\n"),
  };
}

function uvInstallStep(): InstallStep {
  return {
    command: "uv",
    args: ["tool", "install", COCOINDEX_PACKAGE_SPEC],
    displayCommand: `uv tool install '${COCOINDEX_PACKAGE_SPEC}'`,
    description: "Install CocoIndex CLI with LanceDB support using uv",
  };
}

function buildManualInstructions(shell: SupportedShell): string[] {
  const uvInstructions = buildUvInstallerFallback(shell);
  return [
    "Manual installation required:",
    "1. Install uv:",
    ...uvInstructions.map((line) => `   ${line}`),
    "2. Restart your shell if instructed by the installer.",
    `3. Run: uv tool install '${COCOINDEX_PACKAGE_SPEC}'`,
    "4. Re-run /unipi:cocoindex-init.",
    "",
    "If you prefer mise, install mise from https://mise.jdx.dev/getting-started.html, then run:",
    "   mise use -g uv@latest",
    `   uv tool install '${COCOINDEX_PACKAGE_SPEC}'`,
  ];
}

function buildUvInstallerFallback(shell: SupportedShell): string[] {
  if (shell === "fish") {
    return [
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
      "fish_add_path ~/.local/bin",
    ];
  }

  if (shell === "bash" || shell === "zsh") {
    return [
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
      "export PATH=\"$HOME/.local/bin:$PATH\"",
    ];
  }

  return [
    "curl -LsSf https://astral.sh/uv/install.sh | sh",
    "Add ~/.local/bin to PATH for your shell.",
  ];
}

interface StepRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function runStep(step: InstallStep): Promise<StepRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(step.command, step.args ?? [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: installerEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      proc.kill("SIGTERM");
      stderr += `\nTimed out after ${step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS}ms.`;
    }, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code, signal });
    });

    proc.on("error", (err: Error) => {
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr: stderr || err.message });
    });
  });
}

function installerEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extraPaths = [
    join(home, ".local", "bin"),
    join(home, ".local", "share", "mise", "shims"),
  ];
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: [...extraPaths, currentPath].filter(Boolean).join(delimiter),
  };
}

function summarizeCommandOutput(result: StepRunResult): string {
  const parts: string[] = [];
  if (result.exitCode !== undefined) parts.push(`exit code: ${result.exitCode}`);
  if (result.signal) parts.push(`signal: ${result.signal}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${tail(result.stderr.trim())}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${tail(result.stdout.trim())}`);
  return parts.join("\n") || "No command output was captured.";
}

function tail(value: string, maxChars = 4000): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(value.length - maxChars)}`;
}
