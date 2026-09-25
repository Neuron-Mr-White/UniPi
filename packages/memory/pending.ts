/**
 * @unipi/memory — Pending write journal
 *
 * ~/.unipi/memory/.pending.json — a store/delete that never confirmed it
 * landed in the palace goes here, and is replayed in the background at
 * session start and whenever a daemon becomes reachable. This replaces the
 * old ledger + ping-verified + sync_orphaned machinery.
 */

import * as fs from "node:fs";

import * as path from "node:path";
import { memoryRoot } from "./paths.js";

export interface PendingOp {
  kind: "store" | "delete";
  /** Absolute path of the md file (store) or deleted md file (delete). */
  file: string;
  project: string;
  id: string;
  enqueuedAt: string;
  /** The palace-lock holder text when the write failed on MineAlreadyRunning. */
  heldBy?: string;
}

const PENDING_PATH = (): string => path.join(memoryRoot(), ".pending.json");

export function readPending(): PendingOp[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_PATH(), "utf-8")) as { ops?: unknown };
    return Array.isArray(parsed.ops) ? (parsed.ops as PendingOp[]) : [];
  } catch {
    return [];
  }
}

export function writePending(ops: PendingOp[]): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_PATH()), { recursive: true });
    const tmp = `${PENDING_PATH()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ops }, null, 2), "utf-8");
    fs.renameSync(tmp, PENDING_PATH());
  } catch { /* journal is best-effort */ }
}

export function enqueuePending(op: PendingOp): void {
  const ops = readPending().filter(
    (o) => !(o.kind === op.kind && o.file === op.file),
  );
  ops.push(op);
  writePending(ops);
}

export function dropPending(op: PendingOp): void {
  writePending(readPending().filter((o) => o !== op && !(o.kind === op.kind && o.file === op.file)));
}

export function pendingCount(): number {
  return readPending().length;
}

/**
 * Replay the journal against a daemon-driven write backend. Returns the
 * count of ops still pending (they stay journaled).
 */
export async function replayPending(
  fileStore: (op: PendingOp) => Promise<"filed" | "queued" | "markdown-only">,
): Promise<number> {
  const ops = readPending();
  for (const op of ops) {
    let outcome: "filed" | "queued" | "markdown-only" = "markdown-only";
    try {
      outcome = await fileStore(op);
    } catch { /* leave it queued */ }
    if (outcome === "filed") dropPending(op);
  }
  return pendingCount();
}
