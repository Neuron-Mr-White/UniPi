import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export interface FusionFakePiInstallOptions {
  delegatePi?: string | undefined;
  mergedText?: string | undefined;
  delayMs?: number | undefined;
  invalidFirstEvaluation?: boolean | undefined;
  failStage?: 'candidate' | 'evaluation' | 'evaluation-repair' | 'merge' | undefined;
}

export interface FusionFakePiInstallResult {
  binDir: string;
  executable: string;
  packageRoot: string;
  packageJsonPath: string;
  packageCliPath: string;
  resolvePackageJson: (specifier: string) => string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_PACKAGE_MANIFEST = `${PI_PACKAGE_NAME}/package.json`;

export function resolveRealPiCli(): string | undefined {
  const result = spawnSync('bash', ['-lc', 'command -v pi'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function scriptBody(options: FusionFakePiInstallOptions, logPath: string): string {
  const delegate = options.delegatePi ?? '';
  const merged = options.mergedText ?? 'Fused fake answer.';
  const delayMs = options.delayMs ?? 0;
  const invalidFirstEvaluation = options.invalidFirstEvaluation ?? false;
  const failStage = options.failStage ?? '';
  return `const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
const delegate = ${JSON.stringify(delegate)};
const mergedText = ${JSON.stringify(merged)};
const delayMs = ${JSON.stringify(delayMs)};
const invalidFirstEvaluation = ${JSON.stringify(invalidFirstEvaluation)};
const failStage = ${JSON.stringify(failStage)};
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function hasFusionToolPolicy() {
  // Reasoning-only children pass --no-tools. Tool-enabled children (inspect and each
  // later capability) replace it with an explicit allowlist. Both are legitimate
  // fusion children, so recognising only --no-tools would make a tool-enabled child
  // fall through to the delegate path and fail as a non-fusion invocation.
  if (args.includes('--no-tools')) return true;
  return args.includes('--no-builtin-tools') && typeof argValue('--tools') === 'string';
}
function isFusionChild() {
  const extension = argValue('--extension');
  return argValue('--mode') === 'text' && hasFusionToolPolicy() && args.includes('--no-extensions') && args.includes('--no-context-files') && typeof extension === 'string' && /fusion-child\\.(?:ts|js)$/.test(extension);
}
if (!isFusionChild()) {
  if (!delegate) {
    console.error('fusion fake pi received a non-fusion invocation without a delegate');
    process.exit(99);
  }
  const result = spawnSync(delegate, args, { stdio: 'inherit', env: process.env, cwd: process.cwd() });
  if (result.error) {
    console.error(result.error.message);
    process.exit(98);
  }
  process.exit(result.status === null ? 97 : result.status);
}
// The real fusion child extension creates its tool-call log before tools can run,
// so an ABSENT file means the audit trail was never established rather than "zero tool
// calls". The parent enforces that distinction, so the fake must establish the file too
// or every tool-enabled child fails as a missing audit trail.
const toolCallLogPath = process.env.PI_FUSION_TOOL_CALL_LOG_PATH;
if (toolCallLogPath) appendFileSync(toolCallLogPath, '');
const provider = argValue('--provider') || 'fake-provider';
const model = argValue('--model') || 'fake-model';
const systemPrompt = argValue('--system-prompt') || '';
let stdin = '';
try {
  stdin = readFileSync(0, 'utf8');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('fusion fake pi failed to read stdin: ' + message);
  process.exit(96);
}
let stage = 'candidate';
if (systemPrompt.includes('invalid blind-evaluation JSON response')) stage = 'evaluation-repair';
else if (systemPrompt.includes('strict blind evaluator')) stage = 'evaluation';
else if (systemPrompt.includes('final synthesis process')) stage = 'merge';
const workflow = systemPrompt.includes('validation report') || systemPrompt.includes('validation reports') ? 'validate' : 'reason';
appendFileSync(logPath, JSON.stringify({ stage, workflow, provider, model, args, stdin, systemPrompt, cwd: process.cwd(), env: { PI_SESSION_ID: process.env.PI_SESSION_ID || null, PI_PROVIDER: process.env.PI_PROVIDER || null, PI_MODEL: process.env.PI_MODEL || null, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || null } }) + '\\n');
if (failStage && stage === failStage) {
  console.error('fusion fake pi failing requested stage ' + stage);
  process.exit(42);
}
function sourceFindingsFromStdin() {
  try {
    const parsed = JSON.parse(stdin);
    if (!Array.isArray(parsed.candidates)) return [];
    return parsed.candidates.flatMap((candidate) => {
      const report = JSON.parse(candidate.response);
      return (report.findings || []).map((finding, index) => ({ id: candidate.candidate_id + '-F' + String(index + 1).padStart(3, '0'), candidate_id: candidate.candidate_id, ...finding }));
    });
  } catch {
    return [];
  }
}
function evaluationText() {
  const sourceFindings = workflow === 'validate' ? sourceFindingsFromStdin() : [];
  const base = {
    schema_version: 'pi-background-tasks.fusion-evaluation.v1',
    candidate_assessments: [
      { candidate_id: 'A', summary: 'A summary', strengths: ['A strength'], limitations: ['A limitation'], useful_contributions: ['A contribution'], risks: ['A risk'] },
      { candidate_id: 'B', summary: 'B summary', strengths: ['B strength'], limitations: ['B limitation'], useful_contributions: ['B contribution'], risks: ['B risk'] },
      { candidate_id: 'C', summary: 'C summary', strengths: ['C strength'], limitations: ['C limitation'], useful_contributions: ['C contribution'], risks: ['C risk'] }
    ],
    agreements: ['All address the request'],
    conflicts: [{ topic: 'detail', positions: [{ candidate_id: 'A', position: 'A position' }, { candidate_id: 'B', position: 'B position' }], resolution: 'Combine the useful detail' }],
    synthesis_plan: { must_include: [{ candidate_id: 'A', contribution: 'A contribution' }], must_resolve: ['detail'], must_avoid: ['unsupported claims'] }
  };
  if (workflow === 'validate') {
    base.validation_accounting = {
      findings: sourceFindings,
      decisions: sourceFindings.map((finding, index) => ({ source_id: finding.id, disposition: 'include', rationale: 'preserved by fake evaluator', group_id: 'G' + String(index + 1).padStart(3, '0') })),
      groups: sourceFindings.map((finding, index) => ({
        group_id: 'G' + String(index + 1).padStart(3, '0'),
        source_ids: [finding.id],
        severity: finding.severity,
        location: finding.location,
        evidence: finding.evidence,
        impact: finding.impact,
        summary: finding.summary,
        rationale: 'resolved by fake evaluator'
      }))
    };
  }
  return JSON.stringify(base);
}
function validationCandidateText() {
  return JSON.stringify({
    schema_version: 'pi-background-tasks.fusion-validation-candidate.v1',
    findings: [{ severity: 'minor', location: 'README.md:1', evidence: 'fake evidence', impact: 'fake impact', summary: 'fake finding' }],
    verified: ['fake verification'],
    limitations: ['fake limitation']
  });
}
function responseText() {
  if (invalidFirstEvaluation && stage === 'evaluation') return JSON.stringify({ schema_version: 'pi-background-tasks.fusion-evaluation.v1', bad: true });
  if (stage === 'evaluation' || stage === 'evaluation-repair') return evaluationText();
  if (stage === 'merge') return mergedText;
  if (workflow === 'validate') return validationCandidateText();
  return 'Candidate fake answer from ' + provider + '/' + model + '.';
}
function emit() {
  if (toolCallLogPath) {
    const logBytes = readFileSync(toolCallLogPath);
    const seal = {
      schema_version: 'pi-background-tasks.fusion-tool-call-seal.v1',
      status: 'complete',
      record_count: 0,
      total_result_bytes: 0,
      log_sha256: createHash('sha256').update(logBytes).digest('hex')
    };
    writeFileSync(toolCallLogPath + '.seal.json', JSON.stringify(seal) + '\\n', { flag: 'wx', mode: 0o600 });
  }
  const text = responseText();
  const digest = createHash('sha256').update(text, 'utf8').digest('hex');
  const cacheObservation = provider === 'anthropic'
    ? {
        schema_version: 'pi-background-tasks.fusion-claude-cache-observation.v1',
        applicability: 'anthropic',
        source: 'default',
        requested_retention: 'long',
        effective_retention: 'long',
        breakpoint_count: 3,
        request_ordinal: 1
      }
    : {
        schema_version: 'pi-background-tasks.fusion-claude-cache-observation.v1',
        applicability: 'not_applicable',
        source: 'not_applicable',
        requested_retention: null,
        effective_retention: null,
        breakpoint_count: 0,
        request_ordinal: 1
      };
  const metadata = {
    schema_version: 'pi-background-tasks.fusion-child-result.v4',
    provider,
    model,
    stop_reason: 'stop',
    text_blocks: [{ utf8_bytes: Buffer.byteLength(text, 'utf8'), sha256: digest }],
    text_sha256: digest,
    usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 23, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } },
    cache_observation: cacheObservation,
    output_contract: {
      json_rendered_bytes: Buffer.byteLength(JSON.stringify(text), 'utf8'),
      candidate_limit_bytes: stage === 'candidate' ? 49152 : null,
      recovery_role: 'none'
    }
  };
  const eventBytes = Buffer.from(JSON.stringify(metadata) + '\\n', 'utf8');
  const settlement = {
    schema_version: 'pi-background-tasks.fusion-child-settlement.v3',
    status: 'complete',
    record_count: 1,
    records_sha256: createHash('sha256').update(eventBytes).digest('hex'),
    final_record_index: 0,
    final_text_sha256: digest,
    recovered_error_ordinals: [],
    recovered_output_cap_ordinals: [],
    failure_reason: null
  };
  process.stderr.write('\\x1ePI_FUSION_CHILD_RESULT ' + JSON.stringify(metadata) + '\\n');
  process.stderr.write('\\x1ePI_FUSION_CHILD_SETTLEMENT ' + JSON.stringify(settlement) + '\\n');
  process.stdout.write(text + '\\n');
}
if (delayMs > 0) setTimeout(emit, delayMs);
else emit();
`;
}

function executableScript(options: FusionFakePiInstallOptions, logPath: string): string {
  return `#!/usr/bin/env node\n${scriptBody(options, logPath)}`;
}

export async function installFusionFakePi(
  root: string,
  options: FusionFakePiInstallOptions = {},
): Promise<FusionFakePiInstallResult> {
  const binDir = join(root, 'bin');
  const packageRoot = join(root, 'fake-pi-pkg');
  const packageDist = join(packageRoot, 'dist');
  await mkdir(binDir, { recursive: true });
  await mkdir(packageDist, { recursive: true });
  const executable = join(binDir, 'pi');
  const packageJsonPath = join(packageRoot, 'package.json');
  const packageCliPath = join(packageDist, 'cli.cjs');
  const logPath = join(root, 'fusion-fake-pi.jsonl');
  const body = scriptBody(options, logPath);
  await writeFile(executable, executableScript(options, logPath), 'utf8');
  await chmod(executable, 0o755);
  await writeFile(
    packageJsonPath,
    `${JSON.stringify(
      { name: PI_PACKAGE_NAME, version: '0.0.0-test', bin: { pi: 'dist/cli.cjs' } },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(packageCliPath, body, 'utf8');
  await chmod(packageCliPath, 0o755);
  return {
    binDir,
    executable,
    packageRoot,
    packageJsonPath,
    packageCliPath,
    resolvePackageJson: (specifier: string) => {
      if (specifier !== PI_PACKAGE_MANIFEST) {
        throw new Error(`unexpected package manifest specifier: ${specifier}`);
      }
      return packageJsonPath;
    },
    logPath,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  };
}
