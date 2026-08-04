/**
 * Tests for buildPermissionPromptMessage — the `permissions:ui_prompt`
 * payload projection used by the `permission_request` notify event.
 *
 * The test fixtures use `satisfies PermissionPromptEventPayload` to
 * enforce the payload contract at compile time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPermissionPromptMessage,
  type PermissionPromptEventPayload,
} from "../../permission-prompt-message.ts";

describe("buildPermissionPromptMessage", () => {
  it("formats a standard bash permission payload", () => {
    const payload = {
      requestId: "req-1",
      source: "tool",
      surface: "bash",
      value: "npm test",
      agentName: "Current agent",
      message: "Allow this command?",
    } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Current agent requested bash 'npm test'. Allow this command?",
    );
  });

  it("falls back to \"Agent\" when agentName is absent", () => {
    const payload = {
      surface: "edit",
      value: "src/index.ts",
    } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Agent requested edit 'src/index.ts'.",
    );
  });

  it("marks forwarded subagent prompts", () => {
    const payload = {
      surface: "mcp",
      value: "github.create_issue",
      agentName: "explore",
      forwarding: { from: "subagent-1" },
    } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "explore requested mcp 'github.create_issue'. (forwarded)",
    );
  });

  it("does not mark prompts when forwarding is explicitly falsy", () => {
    for (const forwarding of [false, null, "", 0, {}, []]) {
      const payload = {
        surface: "read",
        value: "/etc/hosts",
        forwarding,
      } satisfies PermissionPromptEventPayload;

      const result = buildPermissionPromptMessage(payload);
      assert.equal(
        result.includes("(forwarded)"),
        false,
        `expected no forwarded marker for ${JSON.stringify(forwarding)}`,
      );
    }
  });

  it("uses surface alone when no value is provided", () => {
    const payload = { surface: "bash" } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Agent requested bash access.",
    );
  });

  it("uses value alone when no surface is provided", () => {
    const payload = { value: "rm -rf build" } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Agent requested 'rm -rf build'.",
    );
  });

  it("falls back to the message when surface and value are missing", () => {
    const payload = {
      requestId: "req-2",
      message: "Allow access to the workspace?",
    } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Allow access to the workspace?",
    );
  });

  it("does not duplicate the message when it equals the request clause", () => {
    const payload = {
      surface: "bash",
      value: "npm test",
      agentName: "Current agent",
      message: "Current agent requested bash 'npm test'.",
    } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Current agent requested bash 'npm test'.",
    );
  });

  it("returns a generic fallback for an empty payload", () => {
    assert.equal(
      buildPermissionPromptMessage({}),
      "Pi is waiting for a permission decision.",
    );
  });

  it("handles null, undefined and non-object payloads without throwing", () => {
    for (const payload of [null, undefined, 42, "nope", true]) {
      assert.equal(
        buildPermissionPromptMessage(payload),
        "Pi is waiting for a permission decision.",
      );
    }
  });

  it("treats empty and whitespace-only strings as absent", () => {
    const payload = {
      surface: "   ",
      value: "",
      agentName: "  ",
      message: "\t\n",
    } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Pi is waiting for a permission decision.",
    );
  });

  it("ignores non-string surface/value/message fields", () => {
    const payload = {
      surface: 123,
      value: { cmd: "ls" },
      message: ["a"],
    } as unknown as PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Pi is waiting for a permission decision.",
    );
  });

  it("still reports a forwarded prompt with no other detail", () => {
    const payload = { forwarding: true } satisfies PermissionPromptEventPayload;

    assert.equal(
      buildPermissionPromptMessage(payload),
      "Pi is waiting for a permission decision. (forwarded)",
    );
  });
});
