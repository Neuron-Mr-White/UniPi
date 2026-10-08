/**
 * @pi-unipi/notify — the per-pairing E2E key (UNI-161 §1).
 *
 * The `unipi-host` daemon generates a random 32-byte key at first use and
 * persists it at `$UNIPI_HOST_DIR/notify-key` (default
 * `~/.unipi/app-host/notify-key`, mode 0600 — see
 * `crates/host/src/notify.rs::notify_key_or_create`). The phone receives
 * the same key (base64) over the `notify_config` request's response.
 *
 * This module reads that same file from the pi side, so the ntfy platform
 * can encrypt notification payloads before they ever leave this machine —
 * the ntfy server (self-hosted or not) only ever sees ciphertext.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** `$UNIPI_HOST_DIR/notify-key`, or `~/.unipi/app-host/notify-key` if unset. */
export function notifyKeyPath(): string {
  const dir = process.env.UNIPI_HOST_DIR;
  if (dir && dir.trim() !== "") return join(dir, "notify-key");
  return join(homedir(), ".unipi", "app-host", "notify-key");
}

/** Reads the 32-byte key if present; `undefined` if the host hasn't
 *  generated one yet (first `notify_config` request on the phone creates
 *  it) or the file is malformed. Never throws. */
export function loadNotifyKey(): Buffer | undefined {
  try {
    const bytes = readFileSync(notifyKeyPath());
    if (bytes.length !== 32) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}
