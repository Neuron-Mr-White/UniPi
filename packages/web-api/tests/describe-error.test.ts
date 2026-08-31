/**
 * @unipi/web-api — error serialization tests
 *
 * Regression guard for "Read failed: [object Object]": engine errors used to
 * be plain objects ({ error, code, phase, retryable }), so every boundary
 * catch serialized them to "[object Object]" and hid the diagnosis. Engine
 * errors must be real Error instances, and every boundary must serialize via
 * describeError().
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeError } from "../src/engine/errors.ts";
import { createError } from "../src/engine/extract.ts";
import { withProviderFallthrough } from "../src/tools.ts";
import type { WebProvider } from "../src/providers/base.ts";

describe("describeError", () => {
  it("uses .message for real Error instances", () => {
    assert.equal(describeError(new Error("boom")), "boom");
  });

  it("falls back to toString when message is empty", () => {
    const e = new Error("");
    assert.ok(describeError(e).length > 0);
  });

  it("reads .error from FetchError-shaped plain objects (legacy shape)", () => {
    assert.equal(describeError({ error: "HTTP error: 403 Forbidden" }), "HTTP error: 403 Forbidden");
  });

  it("reads .message / .reason / .detail from plain objects", () => {
    assert.equal(describeError({ message: "m" }), "m");
    assert.equal(describeError({ reason: "r" }), "r");
    assert.equal(describeError({ detail: "d" }), "d");
  });

  it("JSON-serializes objects with no message-like field", () => {
    assert.equal(describeError({ code: 7 }), '{"code":7}');
  });

  it("passes strings through", () => {
    assert.equal(describeError("plain string"), "plain string");
  });

  it("never returns '[object Object]'", () => {
    for (const v of [{}, { a: 1 }, Object.create(null), Symbol("x"), 42, null, undefined]) {
      assert.notEqual(describeError(v), "[object Object]");
    }
  });
});

describe("createError", () => {
  it("returns a real Error with the message set", () => {
    const e = createError("http_error", "waiting", "HTTP error: 403 Forbidden", false, {
      statusCode: 403,
    });
    assert.ok(e instanceof Error, "must be an Error so boundary catches surface .message");
    assert.equal(e.message, "HTTP error: 403 Forbidden");
    assert.equal(e.name, "FetchError");
  });

  it("keeps the FetchError field shape (.error/.code/.phase/.retryable + extras)", () => {
    const e = createError("timeout", "waiting", "timed out", true, { url: "https://x" });
    assert.equal((e as unknown as { error: string }).error, "timed out");
    assert.equal(e.code, "timeout");
    assert.equal(e.phase, "waiting");
    assert.equal(e.retryable, true);
    assert.equal((e as unknown as { url?: string }).url, "https://x");
  });
});

describe("withProviderFallthrough serializes plain-object throws", () => {
  it("surfaces the real cause, not '[object Object]'", async () => {
    const grumpy: WebProvider = {
      id: "grumpy",
      name: "grumpy",
      capabilities: ["search"],
      requiresApiKey: false,
      ranking: { search: 1, read: 0, summarize: 0 },
      config: {},
      async search() {
        throw { error: "HTTP error: 429 Too Many Requests", code: "rate_limited" };
      },
    };
    await assert.rejects(
      () => withProviderFallthrough([grumpy], (p) => p.search()),
      (err: Error) => {
        assert.ok(err.message.includes("429"), `message was: ${err.message}`);
        assert.ok(!err.message.includes("[object Object]"));
        return true;
      },
    );
  });
});
