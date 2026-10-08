/**
 * UNI-161 §1: decrypts the cross-runtime fixture shared with the
 * unipi-app side (`unipi-app/protocol/fixtures/notify-crypto.json`),
 * proving `decryptNotifyPayload` agrees byte-for-byte with the app's
 * WebCrypto decrypt (`apps/mobile/src/lib/notifyCrypto.ts`) on the exact
 * `unipi1:` envelope layout.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { decryptNotifyPayload } from "../../ntfy-crypto.ts";

const here = dirname(fileURLToPath(import.meta.url));
// packages/notify/src/__tests__ -> ../../../../ reaches the unipi repo root;
// the fixture lives in the sibling unipi-app repo's protocol/fixtures.
const fixturePath = join(here, "../../../../unipi-app/protocol/fixtures/notify-crypto.json");

describe("cross-runtime unipi1: envelope fixture", () => {
  it("decrypts the fixture the same way the app's WebCrypto decrypt does", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
      keyB64: string;
      envelope: string;
      payload: Record<string, unknown>;
    };
    const key = Buffer.from(fixture.keyB64, "base64");
    const payload = decryptNotifyPayload(key, fixture.envelope);
    assert.deepEqual(payload, fixture.payload);
  });
});
