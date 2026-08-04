/**
 * Image generation tests.
 *
 * No network: the pi-ai images collection is stubbed. The important contract
 * is that `generateImages` never rejects — failures arrive as
 * `stopReason: "error"` — so every failure mode must be translated into a
 * thrown, actionable error.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildFileName,
  generateImage,
  saveImage,
  slugify,
} from "../src/generate.ts";
import type { ImageGenModel, ImagesModelsLike } from "../src/models.ts";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const MODEL: ImageGenModel = {
  id: "black-forest-labs/flux.2-pro",
  name: "FLUX.2 Pro",
  provider: "openrouter",
  api: "openrouter-images",
};

/**
 * Build a stub images collection returning a fixed result.
 *
 * `noAuth` is a flag rather than an `auth` parameter because passing
 * `undefined` explicitly would trigger a default parameter and silently
 * restore the key — which is exactly how this helper was wrong first time.
 */
function stubImages(result: unknown, noAuth = false): ImagesModelsLike {
  return {
    getModels: () => [MODEL],
    getModel: () => MODEL,
    getAuth: async () => (noAuth ? undefined : { apiKey: "test-key" }),
    generateImages: async () => result,
  };
}

const OK_RESULT = {
  stopReason: "stop",
  output: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-image-gen-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("slugify", () => {
  it("makes a filesystem-safe slug", () => {
    assert.equal(slugify("A cat, sitting on a MAT!"), "a-cat-sitting-on-a-mat");
  });

  it("truncates without a trailing dash", () => {
    const slug = slugify("a".repeat(100));
    assert.ok(slug.length <= 40);
    assert.doesNotMatch(slug, /-$/);
  });

  it("falls back for a prompt with no usable characters", () => {
    assert.equal(slugify("!!!???"), "image");
    assert.equal(slugify(""), "image");
  });
});

describe("buildFileName", () => {
  const now = new Date("2026-07-23T14:30:05.000Z");

  it("includes a timestamp, slug and extension", () => {
    const name = buildFileName("A red bicycle", "image/png", 0, now);
    assert.match(name, /^2026-07-23_14-30-05-a-red-bicycle\.png$/);
  });

  it("uses the right extension per media type", () => {
    assert.match(buildFileName("x", "image/jpeg", 0, now), /\.jpg$/);
    assert.match(buildFileName("x", "image/webp", 0, now), /\.webp$/);
    assert.match(buildFileName("x", "image/gif", 0, now), /\.gif$/);
  });

  it("disambiguates multiple images from one prompt", () => {
    const first = buildFileName("x", "image/png", 0, now);
    const second = buildFileName("x", "image/png", 1, now);
    assert.notEqual(first, second);
    assert.match(second, /-2\.png$/);
  });
});

describe("saveImage", () => {
  it("writes the decoded bytes and creates the directory", () => {
    const target = path.join(tmpDir, "nested", "deeper");
    const saved = saveImage(target, "out.png", PNG_BASE64);

    assert.ok(saved);
    assert.ok(fs.existsSync(saved));
    // Verify real PNG magic numbers landed on disk.
    const bytes = fs.readFileSync(saved);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it("returns undefined rather than throwing when unwritable", () => {
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    assert.equal(saveImage(path.join(blocker, "sub"), "a.png", PNG_BASE64), undefined);
  });
});

describe("generateImage", () => {
  it("returns the generated image", async () => {
    const result = await generateImage({
      prompt: "a red bicycle",
      model: MODEL,
      images: stubImages(OK_RESULT),
    });

    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
    assert.equal(result.images[0].data, PNG_BASE64);
    assert.equal(result.model, MODEL.id);
    assert.equal(result.provider, "openrouter");
  });

  it("saves to disk and reports the path when an output dir is given", async () => {
    const result = await generateImage({
      prompt: "a red bicycle",
      model: MODEL,
      images: stubImages(OK_RESULT),
      outputDir: tmpDir,
    });

    const saved = result.images[0].path;
    assert.ok(saved, "expected a saved path");
    assert.ok(fs.existsSync(saved));
    assert.match(saved, /a-red-bicycle\.png$/);
  });

  it("does not save when no output dir is given", async () => {
    const result = await generateImage({
      prompt: "a red bicycle",
      model: MODEL,
      images: stubImages(OK_RESULT),
    });
    assert.equal(result.images[0].path, undefined);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  it("still returns the image when saving fails", async () => {
    const blocker = path.join(tmpDir, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    const result = await generateImage({
      prompt: "a red bicycle",
      model: MODEL,
      images: stubImages(OK_RESULT),
      outputDir: path.join(blocker, "sub"),
    });

    assert.equal(result.images.length, 1, "a failed save must not discard the image");
    assert.equal(result.images[0].path, undefined);
  });

  it("collects accompanying commentary", async () => {
    const result = await generateImage({
      prompt: "a red bicycle",
      model: MODEL,
      images: stubImages({
        stopReason: "stop",
        output: [
          { type: "text", text: "Here is your bicycle." },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      }),
    });

    assert.equal(result.text, "Here is your bicycle.");
    assert.equal(result.images.length, 1);
  });

  it("returns multiple images", async () => {
    const result = await generateImage({
      prompt: "two variants",
      model: MODEL,
      images: stubImages({
        stopReason: "stop",
        output: [
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      }),
      outputDir: tmpDir,
    });

    assert.equal(result.images.length, 2);
    assert.notEqual(
      result.images[0].path,
      result.images[1].path,
      "saved files must not collide",
    );
  });

  it("throws on an in-band error result", async () => {
    await assert.rejects(
      () =>
        generateImage({
          prompt: "x",
          model: MODEL,
          images: stubImages({
            stopReason: "error",
            errorMessage: "content policy violation",
          }),
        }),
      /content policy violation/,
    );
  });

  it("throws when the request was aborted", async () => {
    await assert.rejects(
      () =>
        generateImage({
          prompt: "x",
          model: MODEL,
          images: stubImages({ stopReason: "aborted" }),
        }),
      /cancelled/i,
    );
  });

  it("throws when no image came back, quoting the model", async () => {
    await assert.rejects(
      () =>
        generateImage({
          prompt: "x",
          model: MODEL,
          images: stubImages({
            stopReason: "stop",
            output: [{ type: "text", text: "I cannot draw that." }],
          }),
        }),
      /I cannot draw that/,
    );
  });

  it("throws when the output is empty", async () => {
    await assert.rejects(
      () =>
        generateImage({
          prompt: "x",
          model: MODEL,
          images: stubImages({ stopReason: "stop", output: [] }),
        }),
      /returned no image/,
    );
  });

  it("requires a non-empty prompt", async () => {
    await assert.rejects(
      () => generateImage({ prompt: "   ", model: MODEL, images: stubImages(OK_RESULT) }),
      /non-empty prompt/,
    );
  });

  it("reports a missing API key with a remedy", async () => {
    await assert.rejects(
      () =>
        generateImage({
          prompt: "x",
          model: MODEL,
          images: stubImages(OK_RESULT, true),
        }),
      (error: Error) => {
        assert.match(error.message, /No API key/);
        assert.match(error.message, /openrouter\.ai/);
        return true;
      },
    );
  });

  it("falls back to an explicit key when pi-ai auth is empty", async () => {
    const result = await generateImage({
      prompt: "x",
      model: MODEL,
      apiKey: "fallback-key",
      images: stubImages(OK_RESULT, true),
    });
    assert.equal(result.images.length, 1);
  });

  it("survives an auth lookup that throws", async () => {
    const images: ImagesModelsLike = {
      getModels: () => [MODEL],
      getModel: () => MODEL,
      getAuth: async () => {
        throw new Error("credential store unavailable");
      },
      generateImages: async () => OK_RESULT,
    };

    const result = await generateImage({
      prompt: "x",
      model: MODEL,
      apiKey: "fallback-key",
      images,
    });
    assert.equal(result.images.length, 1);
  });

  it("skips malformed output parts", async () => {
    const result = await generateImage({
      prompt: "x",
      model: MODEL,
      images: stubImages({
        stopReason: "stop",
        output: [
          null,
          { type: "image" },
          { type: "image", data: "" },
          { type: "text", text: "   " },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      }),
    });

    assert.equal(result.images.length, 1);
    assert.equal(result.text, "");
  });

  it("defaults the media type when the model omits it", async () => {
    const result = await generateImage({
      prompt: "x",
      model: MODEL,
      images: stubImages({
        stopReason: "stop",
        output: [{ type: "image", data: PNG_BASE64 }],
      }),
    });
    assert.equal(result.images[0].mimeType, "image/png");
  });
});
