/**
 * UNI-161 §1: the `unipi1:` AES-256-GCM envelope round-trips, is
 * randomized per call, and the encrypted ntfy body never leaks plaintext
 * in `title`/`message`/`click` — matched against the Node encrypt /
 * TS-side decrypt fixture the app's WebCrypto decrypt must also satisfy
 * (documented in docs/m6/PROTOCOL.md).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { encryptNotifyPayload, decryptNotifyPayload, ENVELOPE_PREFIX } from "../../ntfy-crypto.ts";
import { buildNtfyBody } from "../../platforms/ntfy.ts";

describe("encryptNotifyPayload / decryptNotifyPayload", () => {
  it("round-trips an arbitrary payload", () => {
    const key = randomBytes(32);
    const payload = { title: "pi asks", body: "Which plan?", kind: "ask_user", host: "pc1", pid: 42, dialogId: 3, options: ["A", "B", "C"] };
    const envelope = decryptNotifyPayload(key, encryptNotifyPayload(key, payload));
    assert.deepEqual(envelope, payload);
  });

  it("starts with the unipi1: prefix and never contains the plaintext", () => {
    const key = randomBytes(32);
    const envelope = encryptNotifyPayload(key, { title: "Secret-Title-XYZ", body: "Secret-Body-ABC" });
    assert.ok(envelope.startsWith(ENVELOPE_PREFIX));
    assert.ok(!envelope.includes("Secret-Title-XYZ"));
    assert.ok(!envelope.includes("Secret-Body-ABC"));
  });

  it("uses a random IV so the same payload encrypts differently every call", () => {
    const key = randomBytes(32);
    const payload = { title: "x", body: "y" };
    const a = encryptNotifyPayload(key, payload);
    const b = encryptNotifyPayload(key, payload);
    assert.notEqual(a, b);
  });

  it("rejects a key of the wrong length", () => {
    assert.throws(() => encryptNotifyPayload(randomBytes(16), { title: "x", body: "y" }), /32 bytes/);
  });

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const key = randomBytes(32);
    const envelope = encryptNotifyPayload(key, { title: "x", body: "y" });
    const tampered = envelope.slice(0, -2) + (envelope.endsWith("A") ? "B" : "A");
    assert.throws(() => decryptNotifyPayload(key, tampered));
  });

  it("rejects decryption with the wrong key", () => {
    const envelope = encryptNotifyPayload(randomBytes(32), { title: "x", body: "y" });
    assert.throws(() => decryptNotifyPayload(randomBytes(32), envelope));
  });
});

describe("buildNtfyBody with encryptKey — no plaintext leak", () => {
  it("title is the fixed neutral string, message is ciphertext, click is content-free", () => {
    const key = randomBytes(32);
    const body = buildNtfyBody("my-topic", "Pi needs you: deploy or skip?", "Should I deploy to prod or skip this release?", 3, {
      route: { host: "pc1", pid: 123, dialog: 7, kind: "ask_user" },
      encryptKey: key,
    });
    assert.equal(body.title, "UniPi");
    assert.notEqual(body.message, "Should I deploy to prod or skip this release?");
    assert.ok(!String(body.message).includes("deploy"));
    assert.ok(!String(body.title).includes("deploy"));
    assert.equal(body.click, "unipi://chat?host=pc1&pid=123&dialog=7");
    assert.ok(!String(body.click).includes("deploy"));
    assert.equal(body.tags, undefined);

    const payload = decryptNotifyPayload(key, String(body.message));
    assert.equal(payload.title, "Pi needs you: deploy or skip?");
    assert.equal(payload.kind, "ask_user");
    assert.equal(payload.host, "pc1");
    assert.equal(payload.pid, 123);
  });

  it("appDetail minimal still encrypts only the generic body text", () => {
    const key = randomBytes(32);
    const body = buildNtfyBody("t", "Title", "The real question text", 3, {
      route: { host: "pc1" },
      appDetail: "minimal",
      encryptKey: key,
    });
    const payload = decryptNotifyPayload(key, String(body.message));
    assert.equal(payload.body, "Tap to open in UniPi");
  });

  it("appDetail full encrypts the real message text", () => {
    const key = randomBytes(32);
    const body = buildNtfyBody("t", "Title", "The real question text", 3, {
      route: { host: "pc1" },
      appDetail: "full",
      encryptKey: key,
    });
    const payload = decryptNotifyPayload(key, String(body.message));
    assert.equal(payload.body, "The real question text");
  });

  it("without encryptKey, legacy minimal behaviour is unchanged", () => {
    const body = buildNtfyBody("t", "Title", "The real question text", 3, { route: { host: "pc1", kind: "ask_user" } });
    assert.equal(body.title, "Title");
    assert.equal(body.message, "Tap to open in UniPi");
    assert.deepEqual(body.tags, ["ask_user"]);
  });
});
