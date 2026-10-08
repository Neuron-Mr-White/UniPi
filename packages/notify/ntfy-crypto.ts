/**
 * @pi-unipi/notify — app payload encryption (UNI-161 §1).
 *
 * When the per-pairing key (notify-key.ts) is present, the ntfy platform
 * encrypts the whole app payload before it's handed to ntfy: the ntfy
 * `title` stays a fixed neutral "UniPi", `message` becomes the ciphertext
 * envelope below, and `click` carries only `host`/`pid`/`dialog` — never
 * prompt text. Without a key: unchanged legacy behaviour (plaintext/minimal
 * message, same as before UNI-161 §1).
 *
 * Wire format: `unipi1:` + base64(iv(12) || AES-256-GCM(ciphertext || tag))
 * of the JSON-encoded `NotifyPayload`. The IV is random per message. This
 * exact format is mirrored by the app (Kotlin `javax.crypto` / WebCrypto)
 * — see `apps/mobile/src-tauri/gen/android/.../NotifyCrypto.kt` and
 * `apps/mobile/src/lib/notifyCrypto.ts` on the unipi-app side, and
 * documented in `docs/m6/PROTOCOL.md`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENVELOPE_PREFIX = "unipi1:";

/** The plaintext JSON object encrypted into the ntfy `message` field. */
export interface NotifyPayload {
  title: string;
  body: string;
  kind?: string;
  host?: string;
  pid?: number;
  session?: string;
  dialogId?: number;
  options?: string[];
}

/** AES-256-GCM-encrypts `payload` with `key` (32 raw bytes), returning the
 * full `unipi1:...` envelope string. */
export function encryptNotifyPayload(key: Buffer, payload: NotifyPayload): string {
  if (key.length !== 32) throw new Error(`notify key must be 32 bytes, got ${key.length}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, ciphertext, tag]);
  return `${ENVELOPE_PREFIX}${combined.toString("base64")}`;
}

/** Decrypts one `unipi1:...` envelope. Throws on a bad prefix, length,
 * key, or authentication tag — callers should treat any throw as "drop
 * this notification" rather than show anything. Exported mainly for the
 * Node-side test fixture (`__tests__/ntfy-crypto.test.ts`) that proves the
 * format round-trips; the app does the real decrypt with WebCrypto/
 * javax.crypto so no plaintext secret ever needs Node again. */
export function decryptNotifyPayload(key: Buffer, envelope: string): NotifyPayload {
  if (!envelope.startsWith(ENVELOPE_PREFIX)) throw new Error("missing unipi1: prefix");
  const combined = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), "base64");
  if (combined.length < 12 + 16) throw new Error("envelope too short");
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf-8")) as NotifyPayload;
}
