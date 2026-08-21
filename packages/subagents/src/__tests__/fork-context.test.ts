/**
 * Fork context tests — ported from pi-subagents fork-context semantics:
 * branched session creation via a mocked session manager, Anthropic thinking
 * block sanitization (redacted always; signed only on Anthropic models),
 * thinking-off entry append, cwd alignment, and fail-fast on missing
 * parent/leaf.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createForkContextResolver,
  sanitizeUnsafeThinkingBlocks,
  alignForkedSessionCwd,
  forkedChildRequiresThinkingOff,
  canPreferFork,
} from "../fork-context.js";

const TMP = mkdtempSync(join(tmpdir(), "unipi-fork-test-"));
const parentSessionFile = join(TMP, "parent.jsonl");

function writeParentSession(entries: unknown[]): void {
  writeFileSync(parentSessionFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

function mockSessionManager(branchFile: string | undefined) {
  return {
    getSessionFile: () => parentSessionFile,
    getLeafId: () => "leaf-1",
    openSession: () => ({
      createBranchedSession: () => branchFile,
      getHeader: () => ({ type: "session", id: "root", cwd: "/old/cwd" }),
      getEntries: () => [
        {
          type: "message",
          id: "m1",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "anthropic/claude-x",
            content: [
              { type: "thinking", thinking: "hmm", signature: "sig-abc" },
              { type: "text", text: "answer" },
            ],
          },
        },
        { type: "message", id: "m2", message: { role: "user", content: "question" } },
      ],
    }),
  };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeParentSession([{ type: "session", id: "root", cwd: "/old/cwd" }]);
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("sanitizeUnsafeThinkingBlocks", () => {
  it("strips signed thinking on Anthropic models and redacted_thinking everywhere", () => {
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "anthropic",
          content: [
            { type: "thinking", thinking: "x", signature: "sig" },
            { type: "redacted_thinking", data: "y" },
            { type: "text", text: "keep" },
          ],
        },
      },
    ] as never[];
    assert.equal(sanitizeUnsafeThinkingBlocks(entries), true);
    const content = (entries[0] as never as { message: { content: unknown[] } }).message.content;
    assert.equal(content.length, 1);
    assert.equal((content[0] as { type: string }).type, "text");
  });

  it("keeps unsigned thinking and non-Anthropic thinking", () => {
    const entries = [
      { type: "message", message: { role: "assistant", provider: "openai", content: [{ type: "thinking", thinking: "x" }] } },
      { type: "message", message: { role: "assistant", provider: "anthropic", content: [{ type: "thinking", thinking: "no sig" }] } },
    ] as never[];
    assert.equal(sanitizeUnsafeThinkingBlocks(entries), false);
  });
});

describe("forkedChildRequiresThinkingOff", () => {
  it("conservative for unknown/missing models; anthropic provider/api force off", () => {
    assert.equal(forkedChildRequiresThinkingOff(undefined), true);
    assert.equal(forkedChildRequiresThinkingOff("some-model"), true); // no info
    assert.equal(forkedChildRequiresThinkingOff("some-model", "anthropic"), true);
    assert.equal(forkedChildRequiresThinkingOff("some-model", undefined, "anthropic-messages"), true);
    assert.equal(forkedChildRequiresThinkingOff("some-model", "openai"), false);
    assert.equal(forkedChildRequiresThinkingOff("some-model", "openai", "openai-completions"), false);
  });
});

describe("createForkContextResolver", () => {
  it("fresh context resolves to no-op resolvers", () => {
    const resolver = createForkContextResolver(mockSessionManager(undefined), "fresh");
    assert.equal(resolver.sessionFileForIndex(0), undefined);
    assert.equal(resolver.thinkingOverrideForIndex(0), undefined);
  });

  it("fork without a persisted parent session fails fast", () => {
    assert.throws(
      () => createForkContextResolver({ getSessionFile: () => undefined, getLeafId: () => null }, "fork"),
      /requires a persisted parent session/,
    );
    assert.throws(
      () => createForkContextResolver({ getSessionFile: () => parentSessionFile, getLeafId: () => null }, "fork"),
      /requires a current leaf/,
    );
  });

  it("creates a sanitized fork with thinking-off entry when needed", () => {
    const branchFile = join(TMP, "parent", "forks", "branch.jsonl");
    const resolver = createForkContextResolver(mockSessionManager(branchFile), "fork");
    const resolved = resolver.sessionFileForIndex(0);
    assert.equal(resolved, branchFile);
    assert.ok(existsSync(branchFile));

    // Written content: header + entries with signed thinking stripped + thinking_level_change off
    const lines = readFileSync(branchFile, "utf8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(parsed[0]!.type, "session");
    const assistantEntry = parsed.find((e) => (e.message as { role?: string } | undefined)?.role === "assistant");
    const content = (assistantEntry!.message as { content: Array<{ type: string }> }).content;
    assert.equal(content.filter((b) => b.type === "thinking" || b.type === "redacted_thinking").length, 0);
    const thinkingOff = parsed.find((e) => e.type === "thinking_level_change");
    assert.ok(thinkingOff);
    assert.equal(thinkingOff!.thinkingLevel, "off");
    assert.equal(resolver.thinkingOverrideForIndex(0), "off");
  });

  it("resolves cached per index", () => {
    const branchFile = join(TMP, "parent", "forks", "branch.jsonl");
    const resolver = createForkContextResolver(mockSessionManager(branchFile), "fork");
    assert.equal(resolver.sessionFileForIndex(0), resolver.sessionFileForIndex(0));
  });

  it("nonexistent parent session file errors clearly", () => {
    const missing = join(TMP, "missing.jsonl");
    const resolver = createForkContextResolver(
      {
        getSessionFile: () => missing,
        getLeafId: () => "leaf",
        openSession: () => ({ createBranchedSession: () => undefined }),
      },
      "fork",
    );
    assert.throws(
      () => resolver.sessionFileForIndex(0),
      /Parent session file does not exist/,
    );
  });
});

describe("alignForkedSessionCwd", () => {
  it("rewrites the header cwd to the launch cwd", () => {
    const file = join(TMP, "fork.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "r", cwd: "/old" })}\n`);
    alignForkedSessionCwd(file, TMP);
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { cwd: string };
    assert.equal(header.cwd, TMP);
  });

  it("no-ops when cwd already matches", () => {
    const file = join(TMP, "fork2.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "r", cwd: TMP })}\n`);
    alignForkedSessionCwd(file, TMP);
    const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { cwd: string };
    assert.equal(header.cwd, TMP);
  });
});

describe("canPreferFork", () => {
  it("requires both a session file and a leaf id that exists on disk", () => {
    assert.equal(canPreferFork({ getSessionFile: () => undefined, getLeafId: () => "x" }), false);
    assert.equal(canPreferFork({ getSessionFile: () => parentSessionFile, getLeafId: () => null }), false);
    assert.equal(canPreferFork({ getSessionFile: () => parentSessionFile, getLeafId: () => "leaf" }), true);
  });
});
