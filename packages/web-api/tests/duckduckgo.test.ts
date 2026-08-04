/**
 * DuckDuckGo HTML parser tests.
 *
 * The original parser returned zero results against live DuckDuckGo markup:
 * snippet bodies contain <b> highlights so the `[^<]*` body never matched, and
 * results were dropped whenever the link and snippet counts disagreed. It also
 * handed back `//duckduckgo.com/l/?uddg=...` redirect wrappers instead of real
 * URLs. These tests pin the fixed behaviour against real markup.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeEntities,
  parseDDGResults,
  unwrapRedirect,
} from "../src/providers/duckduckgo.ts";

/** Abridged from a real html.duckduckgo.com response. */
const REAL_MARKUP = `
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.postgresql.org%2Fdocs%2Fcurrent%2Flogical%2Dreplication.html&amp;rut=274da557">PostgreSQL: Documentation: 18: Chapter 29. Logical Replication</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.postgresql.org%2F&amp;rut=274da557"><b>Logical</b> <b>replication</b> is a method of replicating data objects and their changes, based upon their <b>replication</b> identity.</a>
</div>
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc">A Guide &amp; Reference</a>
  </h2>
  <a class="result__snippet">Plain snippet with no markup.</a>
</div>
`;

describe("decodeEntities", () => {
  it("decodes the entities DuckDuckGo emits", () => {
    assert.equal(decodeEntities("A &amp; B"), "A & B");
    assert.equal(decodeEntities("&lt;tag&gt;"), "<tag>");
    assert.equal(decodeEntities("&quot;quoted&quot;"), '"quoted"');
    assert.equal(decodeEntities("it&#x27;s"), "it's");
    assert.equal(decodeEntities("it&#39;s"), "it's");
    assert.equal(decodeEntities("a&nbsp;b"), "a b");
  });

  it("decodes numeric character references", () => {
    assert.equal(decodeEntities("caf&#233;"), "café");
  });

  it("leaves plain text untouched", () => {
    assert.equal(decodeEntities("nothing to do"), "nothing to do");
  });
});

describe("unwrapRedirect", () => {
  it("extracts the real destination from a uddg wrapper", () => {
    assert.equal(
      unwrapRedirect(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.postgresql.org%2Fdocs%2Fcurrent%2Flogical%2Dreplication.html&amp;rut=274da557",
      ),
      "https://www.postgresql.org/docs/current/logical-replication.html",
    );
  });

  it("upgrades a protocol-relative url with no wrapper", () => {
    assert.equal(unwrapRedirect("//example.com/page"), "https://example.com/page");
  });

  it("passes an absolute url through unchanged", () => {
    assert.equal(unwrapRedirect("https://example.com/page"), "https://example.com/page");
  });

  it("does not throw on a malformed percent-encoding", () => {
    const result = unwrapRedirect("//duckduckgo.com/l/?uddg=%E0%A4%A");
    assert.equal(typeof result, "string");
  });
});

describe("parseDDGResults", () => {
  const results = parseDDGResults(REAL_MARKUP);

  it("parses every result in the page", () => {
    assert.equal(results.length, 2);
  });

  it("returns real destination urls, not redirect wrappers", () => {
    assert.equal(
      results[0].url,
      "https://www.postgresql.org/docs/current/logical-replication.html",
    );
    for (const result of results) {
      assert.doesNotMatch(result.url, /duckduckgo\.com\/l\//, "redirect wrapper leaked");
      assert.match(result.url, /^https:\/\//);
    }
  });

  it("keeps snippets that contain <b> highlights", () => {
    assert.equal(
      results[0].snippet,
      "Logical replication is a method of replicating data objects and their changes, based upon their replication identity.",
      "snippet regex must tolerate inline markup",
    );
  });

  it("decodes entities in titles", () => {
    assert.equal(results[1].title, "A Guide & Reference");
  });

  it("pairs each snippet with its own result", () => {
    assert.equal(results[1].snippet, "Plain snippet with no markup.");
  });

  it("does not drop a result that has no snippet", () => {
    const markup = `
      <h2 class="result__title"><a class="result__a" href="https://a.test">First</a></h2>
      <h2 class="result__title"><a class="result__a" href="https://b.test">Second</a></h2>
      <a class="result__snippet">Belongs to the second result only.</a>
    `;
    const parsed = parseDDGResults(markup);
    assert.equal(parsed.length, 2, "a snippet-less result must still be returned");
    assert.equal(parsed[0].title, "First");
    assert.equal(parsed[0].snippet, "", "must not steal the next result's snippet");
    assert.equal(parsed[1].snippet, "Belongs to the second result only.");
  });

  it("returns an empty array for markup with no results", () => {
    assert.deepEqual(parseDDGResults("<html><body>No results.</body></html>"), []);
    assert.deepEqual(parseDDGResults(""), []);
  });

  it("skips entries with an empty title", () => {
    assert.deepEqual(parseDDGResults('<a class="result__a" href="https://a.test"></a>'), []);
  });

  it("collapses whitespace in titles spanning newlines", () => {
    const parsed = parseDDGResults(
      '<a class="result__a" href="https://a.test">A\n   multiline\n title</a>',
    );
    assert.equal(parsed[0].title, "A multiline title");
  });
});
