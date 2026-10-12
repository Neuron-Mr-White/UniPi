/** UNI-275: similarity search over a session branch. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editDistance, searchSession, stem } from "../src/search.js";

const user = (id: string, text: string) => ({ type: "message", id, message: { role: "user", content: text } });
const said = (id: string, text: string) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }] } });
const call = (id: string, name: string, args: object) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", id: `c${id}`, name, arguments: args }] } });
const out = (id: string, text: string) => ({ type: "message", id, message: { role: "toolResult", toolCallId: "x", content: [{ type: "text", text }] } });

const branch = [
  { type: "session", id: "s" },
  user("u1", "Can you fix the flaky login test?"),
  said("a1", "The login test fails because the auth token expires after one minute in CI."),
  call("t1", "bash", { command: "npm test -- login" }),
  out("r1", "FAIL login.test.ts — token expired\n".repeat(20)),
  user("u2", "Now update the README with the new deploy steps"),
  said("a2", "Updated the README: deploy now runs through scripts/deploy.sh."),
  { type: "custom", id: "c1", customType: "unipi-command-echo", data: { text: "/unipi:goal ship the parser" } },
];

describe("search", () => {
  it("stems and edit distance", () => {
    assert.equal(stem("tests"), "test");
    assert.equal(stem("testing"), "test");
    assert.equal(stem("running"), "run");
    assert.equal(editDistance("deploy", "depoly", 2), 1, "a swap is one edit");
    assert.equal(editDistance("login", "logn", 1), 1);
    assert.equal(editDistance("limit", "app", 1), 2, "too far = max+1");
  });

  it("ranks what people said above tool noise", () => {
    const hits = searchSession(branch, "login test");
    assert.deepEqual(hits.slice(0, 2).map((h) => h.id).sort(), ["a1", "u1"]);
    assert.ok(hits.findIndex((h) => h.id === "r1") > 1, "tool output ranks lower");
  });

  it("finds words by stem and typo, not only exact text", () => {
    assert.deepEqual(searchSession(branch, "updating readme").slice(0, 2).map((h) => h.id).sort(), ["a2", "u2"]);
    assert.ok(["user", "assistant"].includes(searchSession(branch, "depoly")[0]!.role), "typo still finds deploy");
    assert.ok(searchSession(branch, "authentication").some((h) => h.id === "a1"), "authentication finds auth");
    assert.ok(searchSession(branch, "auth").some((h) => h.id === "a1"), "auth finds auth");
  });

  it("unrelated short words never match (no typo credit beyond the distance limit)", () => {
    const long = said("x", "App 0.4.7 is out and installed on every device, so images show. " + "Later: inotify limit hit at 122 of 128.");
    const h = searchSession([long], "inotify limit")[0]!;
    assert.deepEqual(h.marks.map(([s, e]) => h.snippet.slice(s, e)), ["inotify", "limit"]);
  });

  it("phrase match wins; snippet marks the matched words", () => {
    const hits = searchSession(branch, "token expires");
    assert.equal(hits[0]?.id, "a1");
    const h = hits[0]!;
    const marked = h.marks.map(([s, e]) => h.snippet.slice(s, e).toLowerCase());
    assert.ok(marked.includes("token") && marked.includes("expires"), JSON.stringify(marked));
  });

  it("commands are searchable; empty / no-match queries give nothing", () => {
    assert.equal(searchSession(branch, "parser")[0]?.id, "c1");
    assert.deepEqual(searchSession(branch, "   "), []);
    assert.deepEqual(searchSession(branch, "kubernetes"), []);
  });
});
