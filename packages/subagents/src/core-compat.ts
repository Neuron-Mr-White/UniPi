/**
 * @pi-unipi/subagents — Local helpers (not in @pi-unipi/core)
 *
 * boundHelperOutput: bounded output with artifact-to-disk fallback.
 * withHerdrBlocked: wraps a fn with herdr:blocked events.
 */

import { emitEvent } from "@pi-unipi/core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface BoundedHelperOutput {
  text: string;
  truncated: boolean;
  originalBytes: number;
  artifactPath?: string;
}

const MAX_RAW_HELPER_ARTIFACT_BYTES = 16 * 1024 * 1024;

export function boundHelperOutput(
  text: string,
  maxBytes = 64 * 1024,
  existingArtifactPath?: string,
): BoundedHelperOutput {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };

  let artifactPath = existingArtifactPath;
  let artifactWarning: string | undefined;
  if (!artifactPath && originalBytes <= MAX_RAW_HELPER_ARTIFACT_BYTES) {
    try {
      const dir = join(homedir(), ".unipi", "tool-results");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      let stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Refusing unsafe tool-result directory: ${dir}`);
      }
      if ((stat.mode & 0o077) !== 0) {
        chmodSync(dir, 0o700);
        stat = lstatSync(dir);
        if ((stat.mode & 0o077) !== 0) throw new Error(`Refusing non-private tool-result directory: ${dir}`);
      }
      artifactPath = join(dir, `helper-${randomUUID()}.txt`);
      writeFileSync(artifactPath, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      artifactWarning = `Full-output artifact unavailable: ${error instanceof Error ? error.message : String(error)}`;
      artifactPath = undefined;
    }
  } else if (!artifactPath) {
    artifactWarning = `Full output exceeded the ${MAX_RAW_HELPER_ARTIFACT_BYTES}-byte local artifact safety cap and was not retained.`;
  }

  const marker = [
    "",
    "--- output bounded by UniPi ---",
    artifactPath ? `Full output: ${artifactPath}` : artifactWarning!,
    `Original size: ${originalBytes} bytes; model-visible ceiling: ${maxBytes} bytes.`,
    ...(artifactPath ? ["Use the read tool with offset/limit to inspect only the needed region."] : []),
  ].join("\n");
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentBudget = Math.max(1, maxBytes - markerBytes - 80);
  const bytes = Buffer.from(text, "utf8");
  const headBytes = Math.ceil(contentBudget * 0.75);
  const tailBytes = Math.max(0, contentBudget - headBytes);
  const head = bytes.subarray(0, headBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  const tail = bytes.subarray(originalBytes - tailBytes).toString("utf8").replace(/^\uFFFD+/u, "");
  let bounded = `${head}\n… ${Math.max(0, originalBytes - contentBudget)} bytes omitted …\n${tail}${marker}`;
  if (Buffer.byteLength(bounded, "utf8") > maxBytes) {
    bounded = Buffer.from(bounded, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  }
  return {
    text: bounded,
    truncated: true,
    originalBytes,
    artifactPath,
  };
}

export async function withHerdrBlocked<T>(
  pi: Pick<ExtensionAPI, "events">,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  emitEvent(pi, "herdr:blocked", { active: true, label });
  try {
    return await fn();
  } finally {
    emitEvent(pi, "herdr:blocked", { active: false, label });
  }
}
