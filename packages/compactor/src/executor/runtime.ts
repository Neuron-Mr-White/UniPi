/**
 * Runtime detection for sandbox executor
 */

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "shell"
  | "ruby"
  | "go"
  | "rust"
  | "php"
  | "perl"
  | "r"
  | "elixir";

export interface RuntimeMap {
  javascript: string;
  typescript: string;
  python: string;
  shell: string;
  ruby?: string;
  go?: string;
  rust?: string;
  php?: string;
  perl?: string;
  r?: string;
  elixir?: string;
}

export function detectRuntimes(): RuntimeMap {
  const runtimes: Partial<RuntimeMap> = {};

  // JavaScript / TypeScript — prefer Bun, fall back to Node
  try {
    const { execSync } = require("node:child_process");
    try {
      execSync("command -v bun", { stdio: "ignore" });
      runtimes.javascript = "bun";
      runtimes.typescript = "bun";
    } catch {
      runtimes.javascript = "node";
      runtimes.typescript = "npx tsx";
    }
  } catch {
    runtimes.javascript = "node";
    runtimes.typescript = "npx tsx";
  }

  // Shell
  runtimes.shell = "bash";

  // Python
  try {
    const { execSync } = require("node:child_process");
    try {
      execSync("command -v python3", { stdio: "ignore" });
      runtimes.python = "python3";
    } catch {
      runtimes.python = "python";
    }
  } catch {
    runtimes.python = "python3";
  }

  // Optional runtimes
  const optional = [
    ["ruby", "ruby"],
    ["go", "go"],
    ["rustc", "rust"],
    ["php", "php"],
    ["perl", "perl"],
    ["Rscript", "r"],
    ["elixir", "elixir"],
  ] as const;

  for (const [cmd, lang] of optional) {
    try {
      const { execSync } = require("node:child_process");
      execSync(`command -v ${cmd}`, { stdio: "ignore" });
      (runtimes as any)[lang] = cmd;
    } catch {
      // not available
    }
  }

  return runtimes as RuntimeMap;
}

export function buildCommand(
  runtimes: RuntimeMap,
  language: Language,
  filePath: string,
): string[] {
  const runtime = runtimes[language];
  if (!runtime) throw new Error(`No runtime available for ${language}`);

  switch (language) {
    case "javascript":
      return runtime === "bun" ? ["bun", "run", filePath] : ["node", filePath];
    case "typescript":
      return runtime === "bun" ? ["bun", "run", filePath] : ["npx", "tsx", filePath];
    case "python":
      return [runtime, filePath];
    case "shell":
      return ["bash", filePath];
    case "ruby":
      return [runtime, filePath];
    case "go":
      return ["go", "run", filePath];
    case "rust":
      return ["__rust_compile_run__", filePath];
    case "php":
      return [runtime, filePath];
    case "perl":
      return [runtime, filePath];
    case "r":
      return [runtime, filePath];
    case "elixir":
      return [runtime, filePath];
    default:
      throw new Error(`Unsupported language: ${language}`);
  }
}
