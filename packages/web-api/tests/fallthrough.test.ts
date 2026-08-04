/**
 * Provider fallthrough tests.
 *
 * wigolo is ranked 1 for search and read but needs a separate
 * `npx wigolo init` (~1.5 GB) before it works. Without fallthrough, an
 * enabled-but-uninitialized wigolo would break every single web call — so this
 * behaviour is what makes "default enabled" safe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withProviderFallthrough } from "../src/tools.ts";
import type { WebProvider } from "../src/providers/base.ts";

/** Build a stub provider whose search either resolves or rejects. */
function stubProvider(id: string, behaviour: "ok" | "fail"): WebProvider {
  return {
    id,
    name: id,
    capabilities: ["search"],
    requiresApiKey: false,
    ranking: { search: 1, read: 0, summarize: 0 },
    config: {},
    async search() {
      if (behaviour === "fail") throw new Error(`${id} is down`);
      return [{ title: id, url: `https://${id}.test`, snippet: "" }];
    },
  };
}

describe("withProviderFallthrough", () => {
  it("returns the first provider's result when it succeeds", async () => {
    const attempted: string[] = [];
    const result = await withProviderFallthrough(
      [stubProvider("first", "ok"), stubProvider("second", "ok")],
      async (p) => {
        attempted.push(p.id);
        return p.id;
      },
    );

    assert.equal(result, "first");
    assert.deepEqual(attempted, ["first"], "must not call later providers on success");
  });

  it("falls through to the next provider when the first fails", async () => {
    const attempted: string[] = [];
    const result = await withProviderFallthrough(
      [stubProvider("wigolo", "fail"), stubProvider("duckduckgo", "ok")],
      async (p) => {
        attempted.push(p.id);
        return p.search!("q");
      },
    );

    assert.deepEqual(attempted, ["wigolo", "duckduckgo"]);
    assert.equal((result as Array<{ title: string }>)[0].title, "duckduckgo");
  });

  it("skips several failing providers", async () => {
    const result = await withProviderFallthrough(
      [
        stubProvider("a", "fail"),
        stubProvider("b", "fail"),
        stubProvider("c", "ok"),
      ],
      async (p) => p.search!("q"),
    );

    assert.equal((result as Array<{ title: string }>)[0].title, "c");
  });

  it("reports every failure when all providers fail", async () => {
    await assert.rejects(
      () =>
        withProviderFallthrough(
          [stubProvider("wigolo", "fail"), stubProvider("duckduckgo", "fail")],
          async (p) => p.search!("q"),
        ),
      (error: Error) => {
        assert.match(error.message, /All 2 providers failed/);
        assert.match(error.message, /wigolo: wigolo is down/);
        assert.match(error.message, /duckduckgo: duckduckgo is down/);
        return true;
      },
    );
  });

  it("rethrows a single failure verbatim (explicit source, no fallback)", async () => {
    await assert.rejects(
      () =>
        withProviderFallthrough([stubProvider("wigolo", "fail")], async (p) =>
          p.search!("q"),
        ),
      (error: Error) => {
        assert.equal(error.message, "wigolo: wigolo is down");
        assert.doesNotMatch(error.message, /All \d+ providers/);
        return true;
      },
    );
  });

  it("propagates non-Error throws as strings", async () => {
    await assert.rejects(
      () =>
        withProviderFallthrough([stubProvider("odd", "ok")], async () => {
          throw "plain string failure";
        }),
      (error: Error) => {
        assert.match(error.message, /plain string failure/);
        return true;
      },
    );
  });
});
