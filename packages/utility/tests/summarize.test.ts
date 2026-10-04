/**
 * @pi-unipi/utility — /unipi:summarize and the bundled summarize skill
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasSummarizeSkill, registerSummarizeCommand, summarizePrompt } from "../src/summarize/index.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function fakePi(commands: string[]) {
  const sent: { text: string; opts: unknown }[] = [];
  const registered: Record<string, Handler> = {};
  const pi = {
    getCommands: () => commands.map((name) => ({ name })),
    registerCommand: (name: string, def: { handler: Handler }) => { registered[name] = def.handler; },
    sendUserMessage: (text: string, opts: unknown) => { sent.push({ text, opts }); },
  };
  return { pi: pi as never, sent, registered };
}

const idle = (notes: string[] = []) => ({ isIdle: () => true, hasUI: true, ui: { notify: (m: string) => notes.push(m) }, waitForIdle: async () => {} });

describe("summarizePrompt", () => {
  it("sends the skill alone when there is no text", () => {
    assert.equal(summarizePrompt(""), "/skill:summarize");
    assert.equal(summarizePrompt("   "), "/skill:summarize");
  });
  it("appends the user's text as-is", () => {
    assert.equal(summarizePrompt("  what behaviour would it change? "), "/skill:summarize what behaviour would it change?");
  });
  it("adds no wording of its own", () => {
    for (const p of [summarizePrompt(""), summarizePrompt("  what behaviour would it change? ")]) {
      assert.doesNotMatch(p, /Summarize this session|Do not call tools|focus on/);
    }
  });
});

describe("/unipi:summarize", () => {
  it("sends the skill prompt with template expansion on", async () => {
    const { pi, sent, registered } = fakePi(["skill:summarize"]);
    registerSummarizeCommand(pi);
    await registered["unipi:summarize"]!("auth fix", idle());
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.text, "/skill:summarize auth fix");
    assert.deepEqual(sent[0]!.opts, { expandPromptTemplates: true });
  });
  it("refuses when the skill is off, and when the agent is busy", async () => {
    const { pi, sent, registered } = fakePi([]);
    registerSummarizeCommand(pi);
    const notes: string[] = [];
    await registered["unipi:summarize"]!("", idle(notes));
    assert.equal(sent.length, 0);
    assert.match(notes[0]!, /summarize skill is off/);
    const on = fakePi(["skill:summarize"]);
    registerSummarizeCommand(on.pi);
    await on.registered["unipi:summarize"]!("", { isIdle: () => false, hasUI: false });
    assert.equal(on.sent.length, 0);
  });
  it("hasSummarizeSkill survives a throwing getCommands", () => {
    assert.equal(hasSummarizeSkill({ getCommands: () => { throw new Error("x"); } } as never), false);
  });
});

describe("summarize SKILL.md", () => {
  const text = readFileSync(new URL("../skills/summarize/SKILL.md", import.meta.url), "utf8");
  it("has kebab-case name and a description that sets it as the final-reply default", () => {
    assert.match(text, /^---\nname: summarize\n/);
    assert.match(text, /final reply/);
    assert.ok(text.includes("last reply"), "mentions the last reply");
    assert.match(text, /unless the\s+user asked for full\s+detail/);
  });
  it("keeps the shape the user picked", () => {
    for (const h of ["## Problems and fixes", "## Not verified", "## Still open", "## Questions for you", "(pick one)", "(your answer)"]) {
      assert.ok(text.includes(h), h);
    }
  });
});
