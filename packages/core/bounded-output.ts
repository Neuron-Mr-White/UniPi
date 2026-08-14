import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_MODEL_OUTPUT_BYTES = 64 * 1024;
export const MAX_RAW_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface BoundedOutput {
  text: string;
  truncated: boolean;
  originalBytes: number;
  visibleBytes: number;
  artifactPath?: string;
}

export interface BoundOutputOptions {
  maxBytes?: number;
  artifactPrefix?: string;
  artifactDir?: string;
}

function byteSlice(text: string, start: number, end?: number): string {
  return Buffer.from(text, "utf8").subarray(start, end).toString("utf8").replace(/\uFFFD+$/u, "");
}

function secureArtifactDir(customDir?: string): string {
  const dir = customDir ?? join(homedir(), ".unipi", "tool-results");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe tool-result directory: ${dir}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
    stat = lstatSync(dir);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Refusing non-private tool-result directory: ${dir}`);
    }
  }
  return dir;
}

function safePrefix(prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 48);
  return safe || "tool-result";
}

/**
 * Bound model-visible UTF-8 output and, up to the raw artifact safety cap,
 * preserve the complete text in a private local artifact.
 *
 * Artifacts use random names and mode 0600 beneath a mode-0700 directory. The
 * returned path is intentionally explicit so the agent can retrieve it with
 * the ordinary read tool only when full output is actually needed.
 */
export function boundModelOutput(text: string, options: BoundOutputOptions = {}): BoundedOutput {
  const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? DEFAULT_MODEL_OUTPUT_BYTES));
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes, visibleBytes: originalBytes };
  }

  let artifactPath: string | undefined;
  let artifactWarning: string | undefined;
  if (originalBytes <= MAX_RAW_ARTIFACT_BYTES) {
    try {
      const dir = secureArtifactDir(options.artifactDir);
      artifactPath = join(dir, `${safePrefix(options.artifactPrefix ?? "tool-result")}-${randomUUID()}.txt`);
      writeFileSync(artifactPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      artifactWarning = `Full-output artifact unavailable: ${error instanceof Error ? error.message : String(error)}`;
      artifactPath = undefined;
    }
  } else {
    artifactWarning = `Full output exceeded the ${MAX_RAW_ARTIFACT_BYTES}-byte local artifact safety cap and was not retained.`;
  }

  const marker = [
    "",
    "--- output bounded by UniPi ---",
    artifactPath ? `Full output: ${artifactPath}` : artifactWarning!,
    `Original size: ${originalBytes} bytes; model-visible ceiling: ${maxBytes} bytes.`,
    ...(artifactPath ? ["Use the read tool with offset/limit to inspect only the needed region."] : []),
  ].join("\n");
  const omissionReserve = 80;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBudget = Math.max(1, maxBytes - markerBytes - omissionReserve);
  const headBytes = Math.ceil(contentBudget * 0.75);
  const tailBytes = Math.max(0, contentBudget - headBytes);
  const head = byteSlice(text, 0, headBytes);
  const tail = tailBytes > 0 ? byteSlice(text, originalBytes - tailBytes) : "";
  const omission = `\n… ${Math.max(0, originalBytes - contentBudget)} bytes omitted …\n`;
  let bounded = `${head}${omission}${tail}${marker}`;
  if (Buffer.byteLength(bounded, "utf8") > maxBytes) {
    bounded = byteSlice(bounded, 0, maxBytes);
  }

  return {
    text: bounded,
    truncated: true,
    originalBytes,
    visibleBytes: Buffer.byteLength(bounded, "utf8"),
    artifactPath,
  };
}
