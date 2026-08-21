/**
 * @pi-unipi/subagents — Fork context resolution
 *
 * Ported from pi-subagents src/shared/fork-context.ts. Creates branched child
 * sessions from the parent session file, sanitizes signed Anthropic thinking
 * blocks (redacted_thinking always; signed thinking on Anthropic models),
 * appends a thinking_level_change:off entry when sanitization occurred, and
 * aligns the forked session cwd to the child launch cwd. Fork files nest
 * under <parent-session-dir>/<parent-stem>/forks/ so top-level session
 * discovery never picks them up.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export type SubagentExecutionContext = "fresh" | "fork";

interface BranchSessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    api?: string;
    model?: string;
  };
  thinkingLevel?: string;
  cwd?: string;
  [extra: string]: unknown;
}

export interface PreferredForkAvailability {
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
}

export interface PreferredForkSnapshot {
  parentSessionFile?: string;
  leafId?: string | null;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
  return value === "fork" ? "fork" : "fresh";
}

export function canPreferFork(sessionManager: PreferredForkAvailability): boolean {
  const parentSessionFile = sessionManager.getSessionFile();
  const leafId = sessionManager.getLeafId();
  if (!parentSessionFile || !leafId) return false;
  try {
    return fs.existsSync(parentSessionFile);
  } catch {
    return false;
  }
}

export function canPreferForkFromSnapshot(input: PreferredForkSnapshot): boolean {
  if (!input.parentSessionFile || !input.leafId) return false;
  try {
    return fs.existsSync(input.parentSessionFile);
  } catch {
    return false;
  }
}

/** Anthropic provider/api models require thinking off on a sanitized fork. */
export function forkedChildRequiresThinkingOff(
  model: string | undefined,
  modelInfoProvider?: string,
  modelInfoApi?: string,
): boolean {
  if (!model) return true;
  if (modelInfoProvider?.toLowerCase() === "anthropic") return true;
  if (modelInfoApi?.toLowerCase() === "anthropic-messages") return true;
  // Unknown models stay conservative (reference rule).
  if (modelInfoProvider === undefined && modelInfoApi === undefined) return true;
  return false;
}

function isUnsafeAnthropicThinkingBlock(message: BranchSessionEntry["message"], block: unknown): boolean {
  if (!message || !block || typeof block !== "object" || !("type" in block)) return false;
  const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
  const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
  const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
  const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
  const b = block as Record<string, unknown>;
  if (b.type === "redacted_thinking") return true;
  if (b.type !== "thinking" || !isAnthropic) return false;
  const signature =
    "thinkingSignature" in b ? b.thinkingSignature : "signature" in b ? b.signature : undefined;
  return b.redacted === true || (typeof signature === "string" && (signature as string).length > 0);
}

function createEntryId(entries: BranchSessionEntry[]): string {
  const ids = new Set(entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) return id;
  }
  return randomUUID();
}

function appendThinkingOffEntry(entries: BranchSessionEntry[]): void {
  const last = entries[entries.length - 1];
  if (last?.type === "thinking_level_change" && last.thinkingLevel === "off") return;
  const parent = [...entries].reverse().find((entry) => typeof entry.id === "string");
  entries.push({
    type: "thinking_level_change",
    id: createEntryId(entries),
    parentId: parent?.id ?? null,
    timestamp: new Date().toISOString(),
    thinkingLevel: "off",
  });
}

/** Strip signed/redacted Anthropic thinking blocks from forked entries. */
export function sanitizeUnsafeThinkingBlocks(entries: BranchSessionEntry[]): boolean {
  let sanitized = false;
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const filtered = (entry.message.content as unknown[]).filter(
      (block) => !isUnsafeAnthropicThinkingBlock(entry.message, block),
    );
    if (filtered.length === (entry.message.content as unknown[]).length) continue;
    entry.message.content = filtered;
    sanitized = true;
  }
  return sanitized;
}

function readSessionEntries(sessionFile: string): BranchSessionEntry[] {
  const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as BranchSessionEntry;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${cause.message}`,
        { cause },
      );
    }
  });
}

/** Align a forked session's cwd to the child launch cwd. */
export function alignForkedSessionCwd(sessionFile: string, cwd: string): void {
  const entries = readSessionEntries(sessionFile);
  const header = entries[0];
  if (header?.type !== "session") {
    throw new Error(`Forked session ${sessionFile} does not start with a session header.`);
  }
  const resolvedCwd = path.resolve(cwd);
  const effectiveCwd = fs.realpathSync.native(resolvedCwd);
  if (header.cwd === effectiveCwd) return;
  header.cwd = effectiveCwd;
  fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
}

export interface ForkContextResolution {
  sessionFile: string;
  thinkingOverride?: "off";
}

export interface ForkContextResolver {
  sessionFileForIndex(index?: number): string | undefined;
  thinkingOverrideForIndex(index?: number): "off" | undefined;
}

interface ForkableSessionManager extends PreferredForkAvailability {
  openSession?: (file: string, dir?: string) => {
    createBranchedSession(leafId: string): string | undefined;
    getHeader?: () => BranchSessionEntry | undefined;
    getEntries?: () => BranchSessionEntry[] | undefined;
  };
}

export interface ForkContextResolverOptions {
  openSession?: ForkableSessionManager["openSession"];
  forceThinkingOffForIndex?: (index: number) => boolean;
}

/**
 * Create the fork resolver. Errors follow reference semantics: an explicit
 * fork requires a persisted parent session + current leaf, failing fast
 * rather than silently downgrading to fresh.
 */
export function createForkContextResolver(
  sessionManager: ForkableSessionManager,
  requestedContext: unknown,
  options: ForkContextResolverOptions = {},
): ForkContextResolver {
  if (resolveSubagentContext(requestedContext) !== "fork") {
    return {
      sessionFileForIndex: () => undefined,
      thinkingOverrideForIndex: () => undefined,
    };
  }

  const parentSessionFile = sessionManager.getSessionFile();
  if (!parentSessionFile) {
    throw new Error("Forked subagent context requires a persisted parent session.");
  }

  const leafId = sessionManager.getLeafId();
  if (!leafId) {
    throw new Error("Forked subagent context requires a current leaf to fork from.");
  }

  const openSession =
    options.openSession ?? sessionManager.openSession ?? ((file: string, dir?: string) => SessionManager.open(file, dir));

  // Fork files nest under <parent-dir>/<parent-stem>/forks/ so top-level
  // session discovery (largest-mtime *.jsonl, non-recursive) never hijacks.
  const sessionDir = path.join(
    path.dirname(parentSessionFile),
    path.basename(parentSessionFile, ".jsonl"),
    "forks",
  );
  const cachedResolutions = new Map<number, ForkContextResolution>();

  const resolveFork = (index = 0): ForkContextResolution => {
    const cached = cachedResolutions.get(index);
    if (cached) return cached;
    try {
      if (!fs.existsSync(parentSessionFile)) {
        throw new Error(
          `Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`,
        );
      }
      const sourceManager = openSession(parentSessionFile, sessionDir);
      const sessionFile = sourceManager.createBranchedSession(leafId);
      if (!sessionFile) {
        throw new Error("Session manager did not return a forked session file.");
      }
      const forceThinkingOff = (sanitized: boolean): boolean =>
        sanitized && (options.forceThinkingOffForIndex?.(index) ?? true);
      let thinkingOverride: "off" | undefined;
      if (!fs.existsSync(sessionFile)) {
        const header = sourceManager.getHeader?.();
        const entries = sourceManager.getEntries?.() as BranchSessionEntry[] | undefined;
        if (!header || !entries) {
          throw new Error(
            `Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`,
          );
        }
        if (forceThinkingOff(sanitizeUnsafeThinkingBlocks(entries as BranchSessionEntry[]))) {
          appendThinkingOffEntry(entries);
          thinkingOverride = "off";
        }
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
      } else {
        const entries = readSessionEntries(sessionFile);
        if (sanitizeUnsafeThinkingBlocks(entries)) {
          if (forceThinkingOff(true)) {
            appendThinkingOffEntry(entries);
            thinkingOverride = "off";
          }
          fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
        }
      }
      const resolution = { sessionFile, ...(thinkingOverride ? { thinkingOverride } : {}) };
      cachedResolutions.set(index, resolution);
      return resolution;
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
    }
  };

  return {
    sessionFileForIndex(index = 0): string | undefined {
      return resolveFork(index).sessionFile;
    },
    thinkingOverrideForIndex(index = 0): "off" | undefined {
      return resolveFork(index).thinkingOverride;
    },
  };
}
