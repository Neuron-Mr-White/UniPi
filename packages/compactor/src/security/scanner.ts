/**
 * Shell-escape scanning — detect subprocess calls in code
 */

const SHELL_ESCAPE_PATTERNS: Record<string, RegExp[]> = {
  python: [
    /\bos\.system\s*\(/i,
    /\bsubprocess\.(?:call|run|Popen)\s*\(/i,
    /\bexec\s*\(/i,
    /\beval\s*\(/i,
  ],
  javascript: [
    /\bchild_process\b/i,
    /\bexec\s*\(/i,
    /\bexecSync\s*\(/i,
    /\bspawn\s*\(/i,
    /\beval\s*\(/i,
  ],
  typescript: [
    /\bchild_process\b/i,
    /\bexec\s*\(/i,
    /\bexecSync\s*\(/i,
    /\bspawn\s*\(/i,
    /\beval\s*\(/i,
  ],
  ruby: [
    /\bbacktick\b/i,
    /\bsystem\s*\(/i,
    /\bexec\s*\(/i,
    /\bspawn\s*\(/i,
    /\b`[^`]*`/,
  ],
  go: [
    /\bos\.Exec\s*\(/i,
    /\bexec\.Command\s*\(/i,
  ],
  php: [
    /\bexec\s*\(/i,
    /\bsystem\s*\(/i,
    /\bshell_exec\s*\(/i,
    /\bpassthru\s*\(/i,
    /\bproc_open\s*\(/i,
  ],
  rust: [
    /\bCommand::new\s*\(/i,
    /\bstd::process::Command\b/i,
  ],
};

export function scanForShellEscapes(code: string, language: string): string[] {
  const patterns = SHELL_ESCAPE_PATTERNS[language] ?? [];
  const findings: string[] = [];

  for (const pattern of patterns) {
    if (pattern.test(code)) {
      findings.push(`Potential shell escape: ${pattern.source}`);
    }
  }

  return findings;
}

export function hasShellEscapes(code: string, language: string): boolean {
  return scanForShellEscapes(code, language).length > 0;
}
