/**
 * Tests for ContentStore trigram/RRF/fuzzy search
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ContentStore } from "../src/store/index.js";

describe("ContentStore search modes", () => {
  let store: ContentStore;

  beforeAll(async () => {
    store = new ContentStore({ dbPath: ":memory:" });
    await store.init();

    // Index test content
    await store.index("readme", "# Project\n\nThis is a test project with authentication module.\n\n## Features\n\n- User login\n- JWT tokens\n- Session management", {
      contentType: "markdown",
      source: "README.md",
    });

    await store.index("auth.ts", "export function authenticate(username: string, password: string) {\n  // JWT token generation\n  return jwt.sign({ user: username }, SECRET);\n}", {
      contentType: "plain",
      source: "src/auth.ts",
    });

    await store.index("config.json", '{"database": "postgres", "port": 3000, "auth": {"secret": "xxx"}}', {
      contentType: "json",
      source: "config.json",
    });
  });

  afterAll(() => {
    store.close();
  });

  it("porter search finds matches", async () => {
    const results = await store.search("authentication", { mode: "porter", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchLayer).toBe("porter");
  });

  it("trigram search finds fuzzy matches", async () => {
    const results = await store.search("authenticaton", { mode: "trigram", limit: 5 }); // typo
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchLayer).toBe("trigram");
  });

  it("rrf mode merges porter and trigram results", async () => {
    const results = await store.search("authentication", { mode: "rrf", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    // RRF should return results ranked by combined score
  });

  it("fuzzy mode applies corrections", async () => {
    const results = await store.search("authenticaton jwt", { mode: "fuzzy", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("search with no matches returns empty", async () => {
    const results = await store.search("xyznonexistent", { mode: "porter", limit: 5 });
    expect(results.length).toBe(0);
  });

  it("search respects limit", async () => {
    const results = await store.search("test", { mode: "porter", limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});
