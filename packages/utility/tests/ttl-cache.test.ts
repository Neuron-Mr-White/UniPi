/**
 * @pi-unipi/utility — TTL Cache tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TTLCache } from "../src/cache/ttl-cache.ts";

describe("TTLCache (memory backend)", () => {
  it("stores and retrieves values", async () => {
    const cache = new TTLCache();
    await cache.set("key", "value");
    const result = await cache.get("key");
    assert.equal(result, "value");
  });

  it("returns undefined for missing keys", async () => {
    const cache = new TTLCache();
    const result = await cache.get("missing");
    assert.equal(result, undefined);
  });

  it("detects expired entries", async () => {
    const cache = new TTLCache({ defaultTtlMs: 10 });
    await cache.set("key", "value");
    assert.equal(await cache.has("key"), true);

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await cache.has("key"), false);
    assert.equal(await cache.get("key"), undefined);
  });

  it("deletes entries", async () => {
    const cache = new TTLCache();
    await cache.set("key", "value");
    assert.equal(await cache.delete("key"), true);
    assert.equal(await cache.get("key"), undefined);
  });

  it("cleans up expired entries", async () => {
    const cache = new TTLCache({ defaultTtlMs: 10 });
    await cache.set("a", 1);
    await cache.set("b", 2);

    await new Promise((r) => setTimeout(r, 50));
    const count = await cache.cleanupExpired();
    assert.equal(count, 2);
  });

  it("clears all entries", async () => {
    const cache = new TTLCache();
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.clear();
    assert.equal(await cache.get("a"), undefined);
    assert.equal(await cache.get("b"), undefined);
  });

  it("supports custom TTL per key", async () => {
    const cache = new TTLCache({ defaultTtlMs: 60000 });
    await cache.set("short", "value", 10);

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await cache.get("short"), undefined);
  });
});
