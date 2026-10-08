/**
 * Media registry (UNI-157 "media + attachments"): the phone-safe snapshot
 * (`snapshot.ts`) replaces big inline images and file-backed attachments
 * with a small `ref` instead of the bytes; this module remembers what each
 * `ref` points at so a later `media{mediaRef}` request (wire.ts) can fetch
 * it, and keeps the host's blob-channel path allow-list
 * (`~/.unipi/bridge/<pid>.files.json`) in sync with every path it sees.
 *
 * Refs are per-process and never persisted: a restarted pi (new pid) hands
 * out fresh refs; the phone re-fetches images it still cares about on
 * reconnect via the usual snapshot/history replay.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MediaEntry = { kind: "base64"; data: string; mime: string } | { kind: "path"; path: string; mime: string };

/** Oldest entries are dropped past this many live refs (bounded memory). */
const MAX_ENTRIES = 500;

let seq = 0;
const entries = new Map<string, MediaEntry>();
/** Every absolute path ever registered this process (written to the
 * allow-list file; never shrinks, so a path stays servable for as long as
 * this pi process lives even after its `MediaEntry` ages out of `entries`). */
const registeredPaths = new Set<string>();

export function bridgeDir(): string {
  return process.env.UNIPI_BRIDGE_DIR || join(homedir(), ".unipi", "bridge");
}

function writeAllowList() {
  try {
    const dir = bridgeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${process.pid}.files.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...registeredPaths]), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // The host simply won't be able to serve these paths; never break pi.
  }
}

function put(entry: MediaEntry): string {
  const ref = `m${process.pid}-${++seq}`;
  entries.set(ref, entry);
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  return ref;
}

/** Registers inline base64 bytes (too big to send whole); returns a ref
 * the phone can `media{mediaRef}` for later. */
export function registerBase64(data: string, mime: string): string {
  return put({ kind: "base64", data, mime });
}

/** Registers a file path (tool result attachment, kanboard attachment,
 * screenshot\u2026) as servable both via `media{mediaRef}` (read fresh off
 * disk) and via the host's `blob_get{path}` (the allow-list file). */
export function registerPath(path: string, mime = "application/octet-stream"): string {
  if (!registeredPaths.has(path)) {
    registeredPaths.add(path);
    writeAllowList();
  }
  return put({ kind: "path", path, mime });
}

export function resolveMedia(ref: string): MediaEntry | undefined {
  return entries.get(ref);
}

/** Test seam: clears everything (refs, allow-list cache) between tests. */
export function resetMediaForTests(): void {
  entries.clear();
  registeredPaths.clear();
  seq = 0;
}
