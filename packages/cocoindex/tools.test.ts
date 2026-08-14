import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SEARCH_RESULTS, normalizeSearchPage, registerCocoindexTools } from "./tools.ts";

describe("CocoIndex result bounds", () => {
  it("publishes a finite result cap in the provider-visible schema", () => {
    const registered: any[] = [];
    registerCocoindexTools({ registerTool: (tool: any) => registered.push(tool) } as any, {
      getProjectDir: () => "/workspace",
    });
    const search = registered.find((tool) => tool.name === "cocoindex_search");
    assert.equal(search.parameters.properties.limit.maximum, MAX_SEARCH_RESULTS);
  });

  it("hard-clamps page values even if host validation is bypassed", () => {
    assert.deepEqual(normalizeSearchPage(), { limit: 10, offset: 0 });
    assert.deepEqual(normalizeSearchPage(1_000, -10), { limit: MAX_SEARCH_RESULTS, offset: 0 });
    assert.deepEqual(normalizeSearchPage(2.9, 4.8), { limit: 2, offset: 4 });
  });
});
