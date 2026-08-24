/**
 * wigolo provider tests.
 *
 * The wigolo daemon is never started here — the provider is driven against a
 * stub client so the response-shape normalization and error handling are
 * covered without network or a 1.5 GB install.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { wigoloProvider } from "../src/providers/wigolo.ts";
import {
  WigoloUnavailableError,
  __resetWigoloClientForTests,
  __setWigoloClientForTests,
  closeWigoloClient,
  getWigoloClient,
  isWigoloInstalled,
} from "../src/providers/wigolo-client.ts";

/** Inject a stub daemon client via the module's test seam. */
function stubClient(impl: Partial<Record<"search" | "fetch" | "health", unknown>>) {
  __setWigoloClientForTests({
    search: impl.search ?? (async () => ({ results: [] })),
    fetch: impl.fetch ?? (async () => ({ markdown: "" })),
    health: impl.health ?? (async () => ({ status: "ok" })),
  } as never);
}

beforeEach(() => {
  __resetWigoloClientForTests();
});

afterEach(() => {
  __resetWigoloClientForTests();
});

describe("wigolo provider contract", () => {
  it("is keyless and ranked first for search and read", () => {
    assert.equal(wigoloProvider.id, "wigolo");
    assert.equal(wigoloProvider.requiresApiKey, false);
    assert.equal(wigoloProvider.apiKeyEnv, undefined);
    assert.deepEqual(wigoloProvider.capabilities, ["search", "read"]);
    assert.equal(wigoloProvider.ranking.search, 1);
    assert.equal(wigoloProvider.ranking.read, 1);
    assert.equal(wigoloProvider.ranking.summarize, 0, "summarize needs an LLM key");
  });
});

describe("wigolo search normalization", () => {
  it("maps results, preferring the byte-pinned excerpt", async () => {
    stubClient({
      search: async () => ({
        results: [
          {
            title: "Logical replication",
            url: "https://www.postgresql.org/docs/current/logical-replication.html",
            excerpt: "Logical replication is a method of replicating data objects…",
            citation_id: "src-1",
          },
        ],
      }),
    });

    const results = await wigoloProvider.search!("logical replication");
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Logical replication");
    assert.match(results[0].snippet, /^Logical replication is a method/);
  });

  it("falls back through snippet, content and description", async () => {
    stubClient({
      search: async () => ({
        results: [
          { url: "https://a.test", snippet: "from snippet" },
          { url: "https://b.test", content: "from content" },
          { url: "https://c.test", description: "from description" },
        ],
      }),
    });

    const results = await wigoloProvider.search!("q");
    assert.deepEqual(
      results.map((r) => r.snippet),
      ["from snippet", "from content", "from description"],
    );
  });

  it("uses the url as the title when none is given", async () => {
    stubClient({ search: async () => ({ results: [{ url: "https://a.test" }] }) });
    const results = await wigoloProvider.search!("q");
    assert.equal(results[0].title, "https://a.test");
    assert.equal(results[0].snippet, "");
  });

  it("drops malformed entries instead of throwing", async () => {
    stubClient({
      search: async () => ({
        results: [null, 42, "nope", {}, { title: "no url" }, { url: "https://ok.test" }],
      }),
    });

    const results = await wigoloProvider.search!("q");
    assert.equal(results.length, 1, "only the entry with a url survives");
    assert.equal(results[0].url, "https://ok.test");
  });

  it("returns an empty array when results is missing or not an array", async () => {
    for (const body of [{}, { results: null }, { results: "nope" }]) {
      stubClient({ search: async () => body });
      assert.deepEqual(await wigoloProvider.search!("q"), []);
    }
  });

  it("surfaces an in-body error field from a 200 response", async () => {
    stubClient({ search: async () => ({ error: "all engines failed" }) });
    await assert.rejects(
      () => wigoloProvider.search!("q"),
      /wigolo search failed: all engines failed/,
    );
  });
});

describe("wigolo read normalization", () => {
  it("returns markdown content", async () => {
    stubClient({
      fetch: async () => ({
        url: "https://example.com/final",
        title: "Example",
        markdown: "# Example\n\nBody text.",
      }),
    });

    const result = await wigoloProvider.read!("https://example.com");
    assert.equal(result.url, "https://example.com/final", "follows redirects");
    assert.equal(result.contentType, "markdown");
    assert.match(result.content, /# Example/);
  });

  it("falls back to the requested url when none is returned", async () => {
    stubClient({ fetch: async () => ({ markdown: "content" }) });
    const result = await wigoloProvider.read!("https://example.com");
    assert.equal(result.url, "https://example.com");
  });

  it("throws when the page yields no content", async () => {
    stubClient({ fetch: async () => ({ markdown: "" }) });
    await assert.rejects(
      () => wigoloProvider.read!("https://example.com"),
      /returned no content/,
    );
  });

  it("surfaces a blocked-by-challenge error", async () => {
    stubClient({ fetch: async () => ({ error: "blocked_by_challenge" }) });
    await assert.rejects(
      () => wigoloProvider.read!("https://example.com"),
      /wigolo fetch failed: blocked_by_challenge/,
    );
  });
});

describe("wigolo availability", () => {
  it("reports not-installed with an actionable message", async (t) => {
    // The SDK is an optional dependency and may not be installed.
    if (await isWigoloInstalled()) {
      t.skip("wigolo-sdk is installed locally");
      return;
    }

    await assert.rejects(
      () => getWigoloClient(),
      (error: Error) => {
        assert.ok(error instanceof WigoloUnavailableError);
        assert.match(error.message, /npm install -g wigolo && npx wigolo init/);
        return true;
      },
    );
  });

  it("throws WigoloUnavailableError rather than a bare Error", async (t) => {
    if (await isWigoloInstalled()) {
      t.skip("wigolo-sdk is installed locally");
      return;
    }

    await assert.rejects(
      () => getWigoloClient(),
      (error: Error) => {
        assert.ok(
          error instanceof WigoloUnavailableError,
          "must be identifiable so callers can fall through",
        );
        assert.match(error.message, /not installed/);
        return true;
      },
    );
  });

  it("does not cache a failed attempt (user may run wigolo init mid-session)", async (t) => {
    if (await isWigoloInstalled()) {
      t.skip("wigolo-sdk is installed locally");
      return;
    }

    await assert.rejects(() => getWigoloClient());
    // A second call must retry rather than return a poisoned cached promise.
    await assert.rejects(() => getWigoloClient(), /not installed/);
  });

  it("closes cleanly even when never started", async () => {
    await closeWigoloClient();
    await closeWigoloClient();
  });
});
