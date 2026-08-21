/**
 * @pi-unipi/subagents — Acceptance gates
 *
 * Ported from pi-subagents src/runs/shared/acceptance.ts (core semantics):
 * levels auto/none/attested/checked/verified, evidence kinds, criteria gates,
 * verify commands run at the host, structured report parsing from child
 * output, and the ledger (status/evidenceStatus/runtimeChecks/verifyRuns).
 */

import { execSync } from "node:child_process";

export const ACCEPTANCE_LEVELS = ["auto", "none", "attested", "checked", "verified"] as const;
export type AcceptanceLevel = (typeof ACCEPTANCE_LEVELS)[number];

export const ACCEPTANCE_EVIDENCE_KINDS = [
  "changed-files",
  "tests-added",
  "commands-run",
  "validation-output",
  "residual-risks",
  "no-staged-files",
  "diff-summary",
  "review-findings",
  "manual-notes",
] as const;
export type AcceptanceEvidenceKind = (typeof ACCEPTANCE_EVIDENCE_KINDS)[number];

const LEVEL_RANK: Record<AcceptanceLevel, number> = {
  none: 0,
  auto: 1,
  attested: 1,
  checked: 2,
  verified: 3,
};

export interface AcceptanceCriterion {
  id: string;
  must: string;
  evidence?: AcceptanceEvidenceKind[];
  severity?: "required" | "recommended";
}

export interface VerifyCommand {
  id: string;
  command: string;
  timeoutMs?: number;
}

export interface AcceptanceConfig {
  level: AcceptanceLevel;
  reason?: string;
  criteria?: AcceptanceCriterion[];
  evidence?: AcceptanceEvidenceKind[];
  verify?: VerifyCommand[];
}

export interface AcceptanceLedger {
  status: "not-required" | "claimed" | "attested" | "checked" | "verified" | "rejected";
  evidenceStatus: string;
  effectiveAcceptance: AcceptanceConfig;
  criteria: AcceptanceCriterion[];
  runtimeChecks: Array<{ id: string; status: "passed" | "failed"; message: string }>;
  verifyRuns: Array<{ id: string; command: string; status: "passed" | "failed" | "timed-out"; output?: string }>;
  failureMessage?: string;
}

// ============================================================================
// Validation (reference error strings)
// ============================================================================

/** Validate an acceptance input; returns error strings (empty = valid). */
export function validateAcceptanceInput(input: unknown, pathLabel = "acceptance"): string[] {
  const errors: string[] = [];
  if (input === undefined || input === false) return errors;
  if (typeof input === "string") {
    if (!ACCEPTANCE_LEVELS.includes(input as AcceptanceLevel)) {
      errors.push(`${pathLabel} has invalid level '${input}'.`);
    } else if (input === "none") {
      errors.push(`${pathLabel} level "none" requires a reason; use { level: "none", reason: "..." }.`);
    } else if (input === "verified") {
      errors.push(`${pathLabel} level "verified" requires object form with at least one runtime verify command. Use level "checked" or provide a non-empty acceptance.verify array.`);
    }
    return errors;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push(`${pathLabel} must be a string level, false, or an object.`);
    return errors;
  }
  const value = input as Record<string, unknown>;
  const allowedKeys = new Set(["level", "reason", "criteria", "evidence", "verify"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) errors.push(`${pathLabel}.${key} is not supported.`);
  }
  if (value.level !== undefined && (typeof value.level !== "string" || !ACCEPTANCE_LEVELS.includes(value.level as AcceptanceLevel))) {
    errors.push(`${pathLabel}.level must be one of ${ACCEPTANCE_LEVELS.join(", ")}.`);
  }
  if (value.level === "none" && (typeof value.reason !== "string" || !(value.reason as string).trim())) {
    errors.push(`${pathLabel}.reason is required when level is none.`);
  }
  if (value.criteria !== undefined && !Array.isArray(value.criteria)) errors.push(`${pathLabel}.criteria must be an array.`);
  if (Array.isArray(value.criteria)) {
    const ids = new Set<string>();
    for (const [index, criterion] of value.criteria.entries()) {
      const criterionPath = `${pathLabel}.criteria[${index}]`;
      if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
        errors.push(`${criterionPath} must be a string or an object.`);
        continue;
      }
      const gate = criterion as Record<string, unknown>;
      if (typeof gate.id !== "string" || !gate.id.trim()) errors.push(`${criterionPath}.id is required.`);
      else {
        const normalized = gate.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        if (ids.has(normalized)) errors.push(`${criterionPath}.id duplicates normalized criterion id '${normalized}'.`);
        ids.add(normalized);
      }
      if (typeof gate.must !== "string" || !gate.must.trim()) errors.push(`${criterionPath}.must is required.`);
      if (gate.evidence !== undefined && !Array.isArray(gate.evidence)) {
        errors.push(`${criterionPath}.evidence must be an array.`);
      }
      if (Array.isArray(gate.evidence)) {
        for (const item of gate.evidence) {
          if (typeof item !== "string" || !ACCEPTANCE_EVIDENCE_KINDS.includes(item as AcceptanceEvidenceKind)) {
            errors.push(`${criterionPath}.evidence contains unsupported kind '${String(item)}'.`);
          }
        }
      }
      if (gate.severity !== undefined && gate.severity !== "required" && gate.severity !== "recommended") {
        errors.push(`${criterionPath}.severity must be required or recommended.`);
      }
    }
  }
  if (value.level === "verified" && (!Array.isArray(value.verify) || value.verify.length === 0)) {
    errors.push(`${pathLabel}.verify must contain at least one runtime command when level is verified.`);
  } else if (value.verify !== undefined && !Array.isArray(value.verify)) {
    errors.push(`${pathLabel}.verify must be an array.`);
  }
  if (Array.isArray(value.verify)) {
    for (const [index, command] of value.verify.entries()) {
      if (!command || typeof command !== "object" || Array.isArray(command)) {
        errors.push(`${pathLabel}.verify[${index}] must be an object with id and command.`);
        continue;
      }
      const cmd = command as Record<string, unknown>;
      if (typeof cmd.id !== "string" || !cmd.id.trim()) errors.push(`${pathLabel}.verify[${index}].id is required.`);
      if (typeof cmd.command !== "string" || !cmd.command.trim()) errors.push(`${pathLabel}.verify[${index}].command is required.`);
    }
  }
  return errors;
}

/** Normalize shorthand forms into a full config. */
export function normalizeAcceptanceInput(input: unknown): AcceptanceConfig | undefined {
  if (input === undefined || input === false) return undefined;
  if (typeof input === "string") {
    return { level: input as AcceptanceLevel };
  }
  const value = input as Record<string, unknown>;
  return {
    level: (value.level as AcceptanceLevel) ?? "auto",
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(Array.isArray(value.criteria) ? { criteria: value.criteria as AcceptanceCriterion[] } : {}),
    ...(Array.isArray(value.evidence) ? { evidence: value.evidence as AcceptanceEvidenceKind[] } : {}),
    ...(Array.isArray(value.verify) ? { verify: value.verify as VerifyCommand[] } : {}),
  };
}

/** Gate shorthand: one host-run verification command. */
export function normalizeGateAcceptance(gate: unknown): AcceptanceConfig | undefined {
  if (typeof gate !== "string" || !gate.trim()) return undefined;
  return {
    level: "verified",
    verify: [{ id: "gate", command: gate.trim() }],
  };
}

// ============================================================================
// Report parsing + evaluation
// ============================================================================

export interface AcceptanceReport {
  criteria?: Array<{ id: string; satisfied: boolean; notes?: string }>;
  evidence?: Partial<Record<AcceptanceEvidenceKind, string>>;
  residualRisks?: string[];
}

const REPORT_OPEN = "<acceptance-report>";
const REPORT_CLOSE = "</acceptance-report>";

/** Parse the structured acceptance report from child output. */
export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
  const start = output.indexOf(REPORT_OPEN);
  const end = output.indexOf(REPORT_CLOSE);
  if (start === -1 || end === -1 || end < start) {
    return { error: "Structured acceptance report not found." };
  }
  const body = output.slice(start + REPORT_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(body) as AcceptanceReport;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return { report: parsed };
  } catch (error) {
    return { error: `Invalid acceptance-report JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Strip the report block from output shown to the parent. */
export function stripAcceptanceReport(output: string): string {
  const start = output.indexOf(REPORT_OPEN);
  const end = output.indexOf(REPORT_CLOSE);
  if (start === -1 || end === -1) return output;
  return (output.slice(0, start) + output.slice(end + REPORT_CLOSE.length)).trim();
}

function checkCriteriaSatisfied(
  criteria: AcceptanceCriterion[],
  report: AcceptanceReport,
): Array<{ id: string; status: "passed" | "failed"; message: string }> {
  const checks: Array<{ id: string; status: "passed" | "failed"; message: string }> = [];
  const reported = new Map((report.criteria ?? []).map((c) => [c.id, c]));
  for (const criterion of criteria) {
    const match = reported.get(criterion.id);
    if (!match) {
      checks.push({
        id: `criterion:${criterion.id}`,
        status: criterion.severity === "recommended" ? "passed" : "failed",
        message: `Criterion '${criterion.id}' missing from child report.`,
      });
    } else if (!match.satisfied && criterion.severity !== "recommended") {
      checks.push({
        id: `criterion:${criterion.id}`,
        status: "failed",
        message: `Criterion '${criterion.id}' not satisfied${match.notes ? `: ${match.notes}` : "."}`,
      });
    } else {
      checks.push({ id: `criterion:${criterion.id}`, status: "passed", message: criterion.must });
    }
  }
  return checks;
}

/**
 * Evaluate acceptance: parse the child's report, check criteria, run verify
 * commands at the host, and produce the ledger.
 */
export async function evaluateAcceptance(input: {
  acceptance: AcceptanceConfig;
  output: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<AcceptanceLedger> {
  const acceptance = input.acceptance;
  const ledger: AcceptanceLedger = {
    status: acceptance.level === "none" ? "not-required" : "claimed",
    evidenceStatus: acceptance.level === "none" ? "not-required" : "claimed",
    effectiveAcceptance: acceptance,
    criteria: acceptance.criteria ?? [],
    runtimeChecks: [],
    verifyRuns: [],
  };
  if (acceptance.level === "none") return ledger;

  // Attestation: structured report present? Gate-shorthand configs (verify
  // commands without criteria) skip the report requirement — the host command
  // IS the verification.
  const gateOnly = (acceptance.verify?.length ?? 0) > 0 && (acceptance.criteria?.length ?? 0) === 0;
  const parsed = parseAcceptanceReport(input.output);
  if (parsed.report) {
    ledger.status = "attested";
    ledger.evidenceStatus = "attested";
  } else if (!gateOnly && (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked || acceptance.level === "attested")) {
    ledger.runtimeChecks.push({ id: "attestation", status: "failed", message: parsed.error ?? "Structured acceptance report missing." });
    ledger.status = "rejected";
    ledger.evidenceStatus = "rejected";
    ledger.failureMessage = `Acceptance rejected: ${parsed.error}`;
    return ledger;
  }

  // Criteria checks at checked+.
  if (parsed.report && LEVEL_RANK[acceptance.level] >= LEVEL_RANK.checked) {
    ledger.runtimeChecks = checkCriteriaSatisfied(ledger.criteria, parsed.report);
    if (ledger.runtimeChecks.some((check) => check.status === "failed")) {
      ledger.status = "rejected";
      ledger.evidenceStatus = "rejected";
      ledger.failureMessage = `Acceptance rejected: ${ledger.runtimeChecks.find((c) => c.status === "failed")!.message}`;
      return ledger;
    }
    ledger.status = "checked";
    ledger.evidenceStatus = "checked";
  }

  // Runtime verify commands at verified+.
  if (LEVEL_RANK[acceptance.level] >= LEVEL_RANK.verified && (acceptance.level === "verified" || (acceptance.verify?.length ?? 0) > 0)) {
    for (const command of acceptance.verify ?? []) {
      if (input.signal?.aborted) break;
      try {
        const output = execSync(command.command, {
          cwd: input.cwd,
          encoding: "utf8",
          timeout: command.timeoutMs ?? 120_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        ledger.verifyRuns.push({ id: command.id, command: command.command, status: "passed", output: output.slice(-2000) });
      } catch (error) {
        const err = error as { status?: number; message?: string; killed?: boolean };
        ledger.verifyRuns.push({
          id: command.id,
          command: command.command,
          status: err.killed ? "timed-out" : "failed",
          output: (err.message ?? "").slice(-2000),
        });
      }
    }
    if (ledger.verifyRuns.some((run) => run.status === "failed" || run.status === "timed-out")) {
      const failed = ledger.verifyRuns.find((r) => r.status !== "passed")!;
      ledger.status = "rejected";
      ledger.evidenceStatus = "rejected";
      ledger.failureMessage = `Acceptance verification '${failed.id}' ${failed.status}.`;
      return ledger;
    }
    if (!ledger.runtimeChecks.some((check) => check.status === "failed")) {
      ledger.status = "verified";
      ledger.evidenceStatus = "verified";
    }
  }

  if (ledger.status === "claimed") {
    ledger.status = acceptance.level === "auto" ? "attested" : (acceptance.level as AcceptanceLedger["status"]);
    ledger.evidenceStatus = ledger.status;
  }
  return ledger;
}
