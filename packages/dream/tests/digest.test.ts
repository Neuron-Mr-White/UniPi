/**
 * @pi-unipi/dream — digest tests (fixtures only, no network).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestSessionFile, digestSessions, encodeSessionDirName, scrub, sessionDirFor } from "../src/digest.ts";

function sessionFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "dream-digest-"));
  const f = join(dir, "2026-10-09T00-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return f;
}

const sid = { type: "session", version: 3, id: "x", timestamp: "t", cwd: "/w/p" };
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const call = (id: string, name: string, args: unknown) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const result = (id: string, name: string, text: string, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text }] },
});

describe("digest", () => {
  it("pairs an error with its recovery (next successful call of the same tool)", () => {
    const f = sessionFile([
      sid,
      user("fix the build"),
      call("1", "bash", { command: "sed -n \"$(grep -n x f)\"" }),
      result("1", "bash", "sed: unknown command: ',' Command exited with code 1", true),
      call("2", "bash", { command: "grep -n x f" }),
      result("2", "bash", "3:x"),
    ]);
    const d = digestSessionFile(f)!;
    assert.equal(d.events.length, 1);
    const e = d.events[0]!;
    assert.equal(e.kind, "tool_error");
    assert.match(e.errorHead!, /sed: unknown command/);
    assert.match(e.recovery!, /grep -n x f/);
    assert.equal(d.errors, 1);
    assert.equal(d.toolCalls, 2);
  });

  it("keeps the first line of a stack trace in errorHead (the run-2 fix)", () => {
    const stack = Array.from({ length: 60 }, (_, i) => `at frame${i} (/deep/node_modules/x/y.js:1:1)`).join("\n");
    const f = sessionFile([
      sid,
      call("1", "bash", { command: "npx tsx /tmp/s.mts" }),
      result("1", "bash", `Error: Cannot find module '@earendil-works/pi-tui'\n${stack}`.repeat(3), true),
    ]);
    const e = digestSessionFile(f)!.events[0]!;
    assert.match(e.errorHead!, /Cannot find module '@earendil-works\/pi-tui'/);
    assert.ok((e.errorHead ?? "").length <= 401);
  });

  it("captures user corrections and scrubs secrets", () => {
    const f = sessionFile([
      sid,
      user("no, wrong — use the token sk-abcdefghij0123456789 for this"),
      call("1", "bash", { command: "deploy" }),
      result("1", "bash", "deployed"),
    ]);
    const d = digestSessionFile(f)!;
    const c = d.events.find((e) => e.kind === "user_correction")!;
    assert.doesNotMatch(c.text!, /sk-abcdefghij/);
    assert.match(c.text!, /<redacted>/);
  });

  it("returns null for sessions without struggle events", () => {
    const f = sessionFile([sid, user("hi"), call("1", "read", { path: "x" }), result("1", "read", "ok")]);
    assert.equal(digestSessionFile(f), null);
  });

  it("digestSessions writes per-session files + INDEX and scrubs", () => {
    const dir = mkdtempSync(join(tmpdir(), "dream-sessions-"));
    writeFileSync(
      join(dir, "2026-10-09T01-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.jsonl"),
      [JSON.stringify(sid), JSON.stringify(call("1", "bash", { command: "x" })), JSON.stringify(result("1", "bash", "9801(*)!Coffee exploded", true))].join("\n"),
    );
    const out = mkdtempSync(join(tmpdir(), "dream-out-"));
    const { count } = digestSessions(dir, out);
    assert.equal(count, 1);
    const stored = JSON.parse(readFileSync(join(out, "2026-10-09T01-00-00-000Z_01234567-89ab-cdef-0123-456789abcdef.json"), "utf8"));
    assert.match(stored.events[0].errorHead, /<redacted> exploded/);
    assert.ok(readFileSync(join(out, "INDEX.json"), "utf8").includes("firstRequest"));
  });

  it("encodes the pi session dir name (verified against a real dir)", () => {
    assert.equal(encodeSessionDirName("/home/oi/Projects/Personal/archived/unipi"), "--home-oi-Projects-Personal-archived-unipi--");
    assert.ok(sessionDirFor("/w/p").endsWith(join("sessions", "--w-p--")));
  });
});
