/**
 * Image input handling tests — file paths, data: URLs, base64, and the error
 * paths a user is most likely to hit.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectMimeType,
  isSupportedMimeType,
  loadImage,
  looksLikeBase64,
  mimeTypeFromExtension,
  parseDataUrl,
} from "../src/image-source.ts";

/** Smallest valid PNG (1x1 transparent). */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BUFFER = Buffer.from(PNG_BASE64, "base64");

const JPEG_BUFFER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(128, 0x20),
]);
const GIF_BUFFER = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(128, 0x20)]);
const WEBP_BUFFER = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
  Buffer.alloc(128, 0x20),
]);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-image-src-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(name: string, buffer: Buffer): string {
  const target = path.join(tmpDir, name);
  fs.writeFileSync(target, buffer);
  return target;
}

describe("mimeTypeFromExtension", () => {
  it("maps the common image extensions", () => {
    assert.equal(mimeTypeFromExtension("a.png"), "image/png");
    assert.equal(mimeTypeFromExtension("a.jpg"), "image/jpeg");
    assert.equal(mimeTypeFromExtension("a.jpeg"), "image/jpeg");
    assert.equal(mimeTypeFromExtension("a.gif"), "image/gif");
    assert.equal(mimeTypeFromExtension("a.webp"), "image/webp");
  });

  it("is case-insensitive", () => {
    assert.equal(mimeTypeFromExtension("PHOTO.PNG"), "image/png");
  });

  it("returns undefined for a non-image extension", () => {
    assert.equal(mimeTypeFromExtension("notes.txt"), undefined);
    assert.equal(mimeTypeFromExtension("noext"), undefined);
  });
});

describe("detectMimeType", () => {
  it("detects each supported format from its magic numbers", () => {
    assert.equal(detectMimeType(PNG_BUFFER), "image/png");
    assert.equal(detectMimeType(JPEG_BUFFER), "image/jpeg");
    assert.equal(detectMimeType(GIF_BUFFER), "image/gif");
    assert.equal(detectMimeType(WEBP_BUFFER), "image/webp");
  });

  it("returns undefined for non-image data", () => {
    assert.equal(detectMimeType(Buffer.from("just some text")), undefined);
    assert.equal(detectMimeType(Buffer.alloc(0)), undefined);
  });
});

describe("isSupportedMimeType", () => {
  it("accepts the vision-API formats and rejects others", () => {
    assert.equal(isSupportedMimeType("image/png"), true);
    assert.equal(isSupportedMimeType("image/webp"), true);
    assert.equal(isSupportedMimeType("image/bmp"), false);
    assert.equal(isSupportedMimeType("application/pdf"), false);
  });
});

describe("parseDataUrl", () => {
  it("parses a base64 data URL", () => {
    const parsed = parseDataUrl(`data:image/png;base64,${PNG_BASE64}`);
    assert.equal(parsed?.mimeType, "image/png");
    assert.equal(parsed?.data, PNG_BASE64);
  });

  it("rejects a non-base64 data URL", () => {
    assert.equal(parseDataUrl("data:text/plain,hello"), null);
  });

  it("rejects a string that is not a data URL", () => {
    assert.equal(parseDataUrl("https://example.com/a.png"), null);
  });
});

describe("looksLikeBase64", () => {
  it("accepts a long base64 payload", () => {
    assert.equal(looksLikeBase64(PNG_BASE64), true);
  });

  it("rejects short strings and prose", () => {
    assert.equal(looksLikeBase64("abc"), false);
    assert.equal(looksLikeBase64("this is a sentence, not base64 data at all!!"), false);
  });
});

describe("loadImage — file paths", () => {
  it("loads a PNG from an absolute path", () => {
    const file = writeFixture("shot.png", PNG_BUFFER);
    const loaded = loadImage(file);

    assert.equal(loaded.mimeType, "image/png");
    assert.equal(loaded.source, "file");
    assert.equal(loaded.path, file);
    assert.equal(loaded.data, PNG_BASE64);
  });

  it("resolves a relative path against the given cwd", () => {
    writeFixture("shot.png", PNG_BUFFER);
    const loaded = loadImage("./shot.png", tmpDir);
    assert.equal(loaded.path, path.join(tmpDir, "shot.png"));
  });

  it("trusts file content over a wrong extension", () => {
    // A PNG misnamed as .jpg must still be reported as PNG.
    const file = writeFixture("mislabeled.jpg", PNG_BUFFER);
    assert.equal(loadImage(file).mimeType, "image/png");
  });

  it("reports a missing file clearly", () => {
    assert.throws(
      () => loadImage(path.join(tmpDir, "nope.png")),
      /Image file not found/,
    );
  });

  it("rejects a directory", () => {
    assert.throws(() => loadImage(tmpDir), /not found|Not a file/i);
  });

  it("rejects an empty file", () => {
    const file = writeFixture("empty.png", Buffer.alloc(0));
    assert.throws(() => loadImage(file), /empty/i);
  });

  it("rejects an unsupported image type", () => {
    const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(128, 0x20)]);
    const file = writeFixture("image.bmp", bmp);
    assert.throws(() => loadImage(file), /Could not determine|Unsupported/);
  });
});

describe("loadImage — data URLs and base64", () => {
  it("loads a data URL", () => {
    const loaded = loadImage(`data:image/png;base64,${PNG_BASE64}`);
    assert.equal(loaded.source, "data-url");
    assert.equal(loaded.mimeType, "image/png");
    assert.equal(loaded.path, undefined);
  });

  it("rejects a malformed data URL", () => {
    assert.throws(() => loadImage("data:image/png,notbase64"), /Malformed data/);
  });

  it("rejects an unsupported data URL type", () => {
    assert.throws(
      () => loadImage("data:image/bmp;base64,Qk0AAAAAAAAAAA=="),
      /Unsupported image type/,
    );
  });

  it("loads raw base64 by sniffing the type", () => {
    const loaded = loadImage(PNG_BASE64);
    assert.equal(loaded.source, "base64");
    assert.equal(loaded.mimeType, "image/png");
  });
});

describe("loadImage — rejected inputs", () => {
  it("explains that remote URLs are not fetched", () => {
    assert.throws(
      () => loadImage("https://example.com/photo.png"),
      /Remote image URLs are not supported/,
    );
  });

  it("rejects an empty string", () => {
    assert.throws(() => loadImage("   "), /No image provided/);
  });

  it("rejects arbitrary prose", () => {
    assert.throws(() => loadImage("please look at my screenshot"), /Could not interpret/);
  });

  it("reports a missing file rather than misreading a path as base64", () => {
    assert.throws(() => loadImage("./missing-screenshot.png", tmpDir), /not found/);
  });
});
