/**
 * @pi-unipi/image — Image input handling
 *
 * Accepts a local file path, a data: URL, or a raw base64 string and
 * normalizes it to the `{ data, mimeType }` shape pi-ai expects.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface LoadedImage {
  /** Base64-encoded image data (no data: prefix). */
  data: string;
  /** IANA media type. */
  mimeType: string;
  /** Where it came from, for the tool's result message. */
  source: "file" | "data-url" | "base64";
  /** Absolute path when loaded from disk. */
  path?: string;
}

/** Media types accepted by the vision APIs. */
export const SUPPORTED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Magic-number signatures, checked before trusting a file extension. */
const SIGNATURES: Array<{ mimeType: string; test: (b: Buffer) => boolean }> = [
  {
    mimeType: "image/png",
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mimeType: "image/jpeg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: "image/gif",
    test: (b) => b.length >= 6 && b.subarray(0, 6).toString("ascii").startsWith("GIF8"),
  },
  {
    mimeType: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

/** Infer a media type from a file extension. */
export function mimeTypeFromExtension(filePath: string): string | undefined {
  return EXTENSION_MIME[path.extname(filePath).toLowerCase()];
}

/** Detect a media type from magic numbers. Authoritative over the extension. */
export function detectMimeType(buffer: Buffer): string | undefined {
  return SIGNATURES.find((s) => s.test(buffer))?.mimeType;
}

/** Whether a media type is accepted by the vision APIs. */
export function isSupportedMimeType(mimeType: string): boolean {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Parse a `data:image/png;base64,...` URL. */
export function parseDataUrl(
  input: string,
): { data: string; mimeType: string } | null {
  const match = input.match(/^data:([^;,]+)(;[^,]*)?,(.*)$/s);
  if (!match) return null;
  const [, mimeType, params, payload] = match;
  if (!params?.includes("base64")) return null;
  return { data: payload.trim(), mimeType: mimeType.trim().toLowerCase() };
}

/** Whether a string plausibly is raw base64 (and long enough to be an image). */
export function looksLikeBase64(input: string): boolean {
  const compact = input.replace(/\s/g, "");
  if (compact.length < 64) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function describeUnsupported(mimeType: string): string {
  return (
    `Unsupported image type "${mimeType}". ` +
    `Supported types: ${SUPPORTED_MIME_TYPES.join(", ")}.`
  );
}

/**
 * Resolve an `image` parameter to base64 data plus a media type.
 *
 * Order: data: URL, then existing file path, then raw base64. A path that
 * looks like a path but does not exist reports the missing file rather than
 * being misread as base64.
 *
 * @throws {Error} with an actionable message on any unusable input.
 */
export function loadImage(input: string, cwd = process.cwd()): LoadedImage {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("No image provided. Pass a file path, a data: URL, or base64 data.");
  }

  // 1. data: URL
  if (trimmed.startsWith("data:")) {
    const parsed = parseDataUrl(trimmed);
    if (!parsed) {
      throw new Error("Malformed data: URL — expected data:<mime>;base64,<data>.");
    }
    if (!isSupportedMimeType(parsed.mimeType)) {
      throw new Error(describeUnsupported(parsed.mimeType));
    }
    return { data: parsed.data, mimeType: parsed.mimeType, source: "data-url" };
  }

  // 2. Remote URLs are not fetched — be explicit rather than silently failing.
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      "Remote image URLs are not supported. " +
        "Download the image first, then pass the local file path.",
    );
  }

  // 3. File path
  const looksLikePath =
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".") ||
    /[\\/]/.test(trimmed) ||
    Boolean(mimeTypeFromExtension(trimmed));

  if (looksLikePath) {
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Image file not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isFile()) {
      throw new Error(`Not a file: ${resolved}`);
    }

    const buffer = fs.readFileSync(resolved);
    if (buffer.length === 0) {
      throw new Error(`Image file is empty: ${resolved}`);
    }

    // Trust the content over the extension.
    const mimeType = detectMimeType(buffer) ?? mimeTypeFromExtension(resolved);
    if (!mimeType) {
      throw new Error(
        `Could not determine the image type of ${resolved}. ` +
          `Supported types: ${SUPPORTED_MIME_TYPES.join(", ")}.`,
      );
    }
    if (!isSupportedMimeType(mimeType)) {
      throw new Error(describeUnsupported(mimeType));
    }

    return {
      data: buffer.toString("base64"),
      mimeType,
      source: "file",
      path: resolved,
    };
  }

  // 4. Raw base64
  if (looksLikeBase64(trimmed)) {
    const compact = trimmed.replace(/\s/g, "");
    const mimeType = detectMimeType(Buffer.from(compact, "base64"));
    if (!mimeType) {
      throw new Error(
        "Could not determine the image type of the supplied base64 data. " +
          "Prefer a file path, or use a data: URL that declares the media type.",
      );
    }
    return { data: compact, mimeType, source: "base64" };
  }

  throw new Error(
    `Could not interpret "${truncate(trimmed)}" as an image. ` +
      "Pass a local file path, a data: URL, or base64-encoded image data.",
  );
}

function truncate(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
