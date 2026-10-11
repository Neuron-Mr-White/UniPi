/**
 * UNI-261 — wreq-js is an optional native dependency.
 *
 * On Windows without the VC++ runtime the wreq-js binding throws at import
 * time. A static import used to take down the entire UniPi bundle. The module
 * must now load regardless, and the smart-fetch engine must fall back to
 * plain fetch with a clear status.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import {
  getWreq,
  wreqStatus,
  checkDependencies,
  setWreqLoaderForTests,
  fallbackFetcher,
  wreqFixHint,
} from "../src/engine/dependencies.ts";

const NATIVE_ERR = "Failed to load native module for win32-x64-msvc. Tried: ../rust/wreq-js.win32-x64-msvc.node";

describe("wreq-js optional loading", () => {
  after(() => setWreqLoaderForTests(null));

  it("importing the web-api extension never touches wreq-js", async () => {
    let loads = 0;
    setWreqLoaderForTests(async () => {
      loads++;
      throw new Error(NATIVE_ERR);
    });
    const mod = await import("../src/index.ts");
    assert.equal(typeof mod.default, "function");
    const tools = await import("../src/tools.ts");
    assert.equal(typeof tools.registerWebTools, "function");
    assert.equal(loads, 0, "wreq-js must not load at import time");
    assert.equal(wreqStatus().mode, "unloaded");
  });

  it("falls back to plain fetch and reports why when the native import throws", async () => {
    setWreqLoaderForTests(async () => {
      throw new Error(NATIVE_ERR);
    });
    const impl = await getWreq();
    assert.equal(impl, fallbackFetcher);
    assert.equal(wreqStatus().mode, "fallback");
    assert.match(wreqStatus().error ?? "", /win32-x64-msvc/);
    const deps = await checkDependencies();
    assert.equal(deps.available, false);
    assert.deepEqual(deps.missing, ["wreq-js (native)"]);
    assert.match(deps.note ?? "", /plain-fetch fallback/);
  });

  it("uses wreq-js when it loads", async () => {
    const fake = { fetch: async () => { throw new Error("unused"); } };
    setWreqLoaderForTests(async () => fake);
    assert.equal(await getWreq(), fake);
    assert.equal(wreqStatus().mode, "wreq");
    assert.equal((await checkDependencies()).available, true);
    // CJS-style default export is accepted too.
    setWreqLoaderForTests(async () => ({ default: fake }));
    assert.equal(await getWreq(), fake);
  });

  it("the real wreq-js loads on this machine", async () => {
    setWreqLoaderForTests(null);
    const impl = await getWreq();
    assert.equal(typeof impl.fetch, "function");
  });

  it("windows fix hint names the VC++ runtime", () => {
    assert.match(wreqFixHint("win32"), /VCRedist\.2015\+\.x64/);
    assert.match(wreqFixHint("win32"), /aka\.ms\/vs\/17\/release\/vc_redist\.x64\.exe/);
    assert.doesNotMatch(wreqFixHint("linux"), /VCRedist/);
  });

  it("defuddleFetch reads a page through the fallback", async () => {
    let server: Server | undefined;
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><head><title>Fallback page</title></head><body><article><h1>Hello fallback</h1><p>The plain fetch path works without the native binding at all, which is the whole point of this test.</p></article></body></html>");
      });
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as { port: number }).port;
      setWreqLoaderForTests(async () => {
        throw new Error(NATIVE_ERR);
      });
      const { defuddleFetch } = await import("../src/engine/extract.ts");
      const res = await defuddleFetch(`http://127.0.0.1:${port}/`, { format: "text" });
      const content = res.content;
      assert.match(content, /Hello fallback|plain fetch path/);
      assert.equal(wreqStatus().mode, "fallback");
    } finally {
      server?.close();
    }
  });

  it("fallback maps timeouts to a timeout message", async () => {
    const server = createServer(() => { /* never answer */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      await assert.rejects(
        fallbackFetcher.fetch(`http://127.0.0.1:${port}/`, { timeout: 200 }),
        /timeout/,
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
