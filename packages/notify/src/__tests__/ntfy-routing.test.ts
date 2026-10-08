/**
 * ntfy platform (UNI-161 §4): the deep link / tags / minimal-vs-full
 * message shape, the UnifiedPush endpoint fanout, and app-endpoints.json
 * persistence. `fetch` is mocked throughout — never a real network call.
 */
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDeepLink, buildNtfyBody, sendNtfyNotification, publishToEndpoint } from "../../platforms/ntfy.ts";
import { loadAppEndpoints, registerAppEndpoint, unregisterAppEndpoint } from "../../app-endpoints.ts";

describe("buildDeepLink", () => {
  it("builds unipi://chat?host=&pid=&dialog= with only the given fields", () => {
    assert.equal(buildDeepLink({ host: "my-pc" }), "unipi://chat?host=my-pc");
    assert.equal(buildDeepLink({ host: "my-pc", pid: 42, dialog: 7 }), "unipi://chat?host=my-pc&pid=42&dialog=7");
  });
});

describe("buildNtfyBody", () => {
  it("no route: full message, no click/tags", () => {
    const body = buildNtfyBody("t", "Title", "The question text", 3);
    assert.equal(body.message, "The question text");
    assert.equal(body.click, undefined);
    assert.equal(body.tags, undefined);
  });

  it("route + appDetail minimal (default): generic message, click + tags set", () => {
    const body = buildNtfyBody("t", "Title", "The question text", 3, { route: { host: "pc1", pid: 99, dialog: 3, kind: "ask_user" } });
    assert.equal(body.message, "Tap to open in UniPi");
    assert.equal(body.click, "unipi://chat?host=pc1&pid=99&dialog=3");
    assert.deepEqual(body.tags, ["ask_user"]);
  });

  it("route + appDetail full: the real message rides along too", () => {
    const body = buildNtfyBody("t", "Title", "The question text", 3, { route: { host: "pc1" }, appDetail: "full" });
    assert.equal(body.message, "The question text");
    assert.equal(body.click, "unipi://chat?host=pc1");
  });

  it("priority clamps to 1..5", () => {
    assert.equal(buildNtfyBody("t", "T", "m", 99).priority, 5);
    assert.equal(buildNtfyBody("t", "T", "m", -1).priority, 1);
  });
});

describe("sendNtfyNotification — fetch mocked", () => {
  let calls: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    calls = [];
    originalFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the topic + route to the server root", async () => {
    await sendNtfyNotification("https://ntfy.sh", "my-topic", "Pi asks", "Which plan?", 3, undefined, {
      route: { host: "pc1", pid: 123, dialog: 1, kind: "ask_user" },
      appDetail: "minimal",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://ntfy.sh");
    assert.equal(calls[0]!.body.topic, "my-topic");
    assert.equal(calls[0]!.body.click, "unipi://chat?host=pc1&pid=123&dialog=1");
    assert.deepEqual(calls[0]!.body.tags, ["ask_user"]);
    assert.equal(calls[0]!.body.message, "Tap to open in UniPi");
  });

  it("throws on a non-ok response", async () => {
    global.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(() => sendNtfyNotification("https://ntfy.sh", "t", "T", "m", 3), /ntfy API error 500/);
  });
});

describe("publishToEndpoint — fetch mocked", () => {
  it("posts to the endpoint URL directly, no topic field, same route/tags shape", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = global.fetch;
    global.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await publishToEndpoint("https://ntfy.sh/up-endpoint-xyz", "Pi asks", "Which plan?", 3, { route: { host: "pc1", kind: "ask_user" } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, "https://ntfy.sh/up-endpoint-xyz");
      assert.equal((calls[0]!.body as { topic?: unknown }).topic, undefined);
      assert.equal((calls[0]!.body as { click?: unknown }).click, "unipi://chat?host=pc1");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("throws on a non-ok response", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response("bad", { status: 410 })) as typeof fetch;
    try {
      await assert.rejects(() => publishToEndpoint("https://ntfy.sh/dead", "T", "m", 3), /endpoint publish error 410/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("app-endpoints.json", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "notify-endpoints-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("starts empty, registers, de-dupes by URL, unregisters", () => {
    assert.deepEqual(loadAppEndpoints(), []);
    registerAppEndpoint("https://ntfy.sh/ep-1");
    registerAppEndpoint("https://ntfy.sh/ep-2");
    assert.deepEqual(loadAppEndpoints().map((e) => e.url).sort(), ["https://ntfy.sh/ep-1", "https://ntfy.sh/ep-2"]);
    // Re-registering the same URL refreshes it, not duplicates it.
    registerAppEndpoint("https://ntfy.sh/ep-1");
    assert.equal(loadAppEndpoints().length, 2);
    unregisterAppEndpoint("https://ntfy.sh/ep-1");
    assert.deepEqual(loadAppEndpoints().map((e) => e.url), ["https://ntfy.sh/ep-2"]);
  });

  it("ignores blank URLs", () => {
    registerAppEndpoint("   ");
    assert.deepEqual(loadAppEndpoints(), []);
  });
});
