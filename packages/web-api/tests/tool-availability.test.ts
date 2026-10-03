/**
 * Web tool availability + sync tests (UNI-72).
 *
 * Tools that cannot work must not be exposed to the agent. These tests pin:
 *   - availability from config (project scope under a temp cwd, temp HOME so
 *     the developer's global config never leaks in — the global scope is
 *     never written),
 *   - syncWebTools touching only the three web tools,
 *   - failing tool executions throwing (pi ignores isError results).
 *
 * Zero network: every failure path is "no provider configured".
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerWebTools, syncWebTools, webToolAvailability, WEB_TOOLS } from "../src/tools.ts";

// Provider registration is an import side effect, mirroring src/index.ts.
import "../src/providers/wigolo.ts";
import "../src/providers/duckduckgo.ts";
import "../src/providers/jina-search.ts";
import "../src/providers/jina-reader.ts";
import "../src/providers/serpapi.ts";
import "../src/providers/tavily.ts";
import "../src/providers/firecrawl.ts";
import "../src/providers/perplexity.ts";

const HOME = mkdtempSync(join(tmpdir(), "unipi-webapi-home-"));
const CWD = mkdtempSync(join(tmpdir(), "unipi-webapi-cwd-"));
const CONFIG_DIR = join(CWD, ".unipi", "config", "web-api");
let prevHome: string | undefined;
let prevCwd: string;

/** Write the project-scope config (never global). */
function setProjectProviders(providers: Record<string, unknown>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, "config.json"), JSON.stringify({ providers }));
}

function clearProjectConfig(): void {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
}

function fakePi(initial: string[] = ["read", "bash", "edit"]) {
  const calls: string[][] = [];
  let active = [...initial];
  return {
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
      calls.push([...tools]);
    },
    active: () => active,
    calls,
  };
}

function registeredTools() {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
  registerWebTools({ registerTool: (t: never) => tools.push(t as never) } as never);
  return new Map(tools.map((t) => [t.name, t]));
}

const ALL_KEYLESS_OFF = {
  wigolo: { enabled: false },
  duckduckgo: { enabled: false },
  "jina-search": { enabled: false },
};

before(() => {
  prevHome = process.env.HOME;
  prevCwd = process.cwd();
  // Isolate the global scope (defaults only) and point the project scope at
  // the temp dir. Both are resolved at call time, so this must happen before
  // the first getSettings call.
  process.env.HOME = HOME;
  process.chdir(CWD);
  clearProjectConfig();
});

after(() => {
  process.env.HOME = prevHome;
  process.chdir(prevCwd);
  rmSync(HOME, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
});

test("default config: search and read available, summarize not", () => {
  const a = webToolAvailability();
  assert.equal(a[WEB_TOOLS.SEARCH], true);
  assert.equal(a[WEB_TOOLS.READ], true);
  assert.equal(a[WEB_TOOLS.SUMMARIZE], false);
});

test("all keyless search providers disabled and no keys: web_search off", () => {
  setProjectProviders(ALL_KEYLESS_OFF);
  const a = webToolAvailability();
  assert.equal(a[WEB_TOOLS.SEARCH], false);
  assert.equal(a[WEB_TOOLS.READ], true, "smart-fetch is local — read stays on");
  assert.equal(a[WEB_TOOLS.SUMMARIZE], false);
  clearProjectConfig();
});

test("perplexity enabled with a key: summarize on", () => {
  setProjectProviders({ perplexity: { enabled: true, apiKey: "px-test-key" } });
  const a = webToolAvailability();
  assert.equal(a[WEB_TOOLS.SUMMARIZE], true);
  clearProjectConfig();
});

test("perplexity enabled without a key: summarize stays off", () => {
  setProjectProviders({ perplexity: { enabled: true } });
  assert.equal(webToolAvailability()[WEB_TOOLS.SUMMARIZE], false);
  clearProjectConfig();
});

test("sync adds only missing web tools, preserving other tools and order", () => {
  const pi = fakePi(["read", "bash", "edit"]);
  syncWebTools(pi as never, {
    [WEB_TOOLS.SEARCH]: true,
    [WEB_TOOLS.READ]: false,
    [WEB_TOOLS.SUMMARIZE]: true,
  });
  assert.deepEqual(pi.active(), ["read", "bash", "edit", "web_search", "web_llm_summarize"]);
  assert.equal(pi.calls.length, 1);
});

test("sync removes unavailable web tools but keeps every other tool", () => {
  const pi = fakePi(["read", "bash", WEB_TOOLS.SEARCH, WEB_TOOLS.READ, "edit"]);
  syncWebTools(pi as never, {
    [WEB_TOOLS.SEARCH]: false,
    [WEB_TOOLS.READ]: true,
    [WEB_TOOLS.SUMMARIZE]: false,
  });
  assert.deepEqual(pi.active(), ["read", "bash", WEB_TOOLS.READ, "edit"]);
  assert.equal(pi.calls.length, 1);
});

test("sync makes no setActiveTools call when nothing changes", () => {
  const pi = fakePi(["bash", WEB_TOOLS.SEARCH, WEB_TOOLS.READ]);
  syncWebTools(pi as never, {
    [WEB_TOOLS.SEARCH]: true,
    [WEB_TOOLS.READ]: true,
    [WEB_TOOLS.SUMMARIZE]: false,
  });
  assert.equal(pi.calls.length, 0);
});

test("search with no configured provider throws", async () => {
  setProjectProviders(ALL_KEYLESS_OFF);
  const search = registeredTools().get(WEB_TOOLS.SEARCH)!;
  await assert.rejects(
    () => search.execute("t1", { query: "x" }, undefined, undefined, undefined),
    /Search failed: No search provider configured/,
  );
  clearProjectConfig();
});

test("read with an invalid url parameter throws", async () => {
  const read = registeredTools().get(WEB_TOOLS.READ)!;
  await assert.rejects(
    () => read.execute("t1", { url: 42 as never }, undefined, undefined, undefined),
    /Invalid url parameter/,
  );
});

test("summarize with perplexity unconfigured throws", async () => {
  clearProjectConfig();
  const summarize = registeredTools().get(WEB_TOOLS.SUMMARIZE)!;
  await assert.rejects(
    () => summarize.execute("t1", { url: "https://example.test" }, undefined, undefined, undefined),
    /Summarize failed: No summarize provider configured/,
  );
});
