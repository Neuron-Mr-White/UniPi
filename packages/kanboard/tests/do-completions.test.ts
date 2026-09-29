/**
 * /unipi:kanboard-do argument completions — only bare task-id tokens suggest
 * rows; free prose never does. Rows carry id + title as the label and the
 * status as the description.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { kanboardDoCompletions, type CommandDeps } from "../src/commands.js";

interface FakeTask {
  id: string;
  title: string;
  status: string;
}

function depsWith(tasks: FakeTask[]): CommandDeps {
  return {
    cli: {
      run: async (args: string[]) => {
        assert.equal(args[0], "list");
        return { tasks };
      },
    },
    unavailable: null,
  } as unknown as CommandDeps;
}

const board = depsWith([
  { id: "UNI-12", title: "Skill settings", status: "todo" },
  { id: "UNI-3", title: "Board runner", status: "in_progress" },
  { id: "SWARM-2", title: "unify the docs", status: "todo" },
  { id: "OLD-1", title: "cancelled work", status: "cancelled" },
]);

function row(item: { value: string; label: string; description?: string }): string {
  return `${item.value}|${item.label}|${item.description}`;
}

describe("kanboardDoCompletions", () => {
  it("free prose gets no suggestions", async () => {
    assert.equal(await kanboardDoCompletions(board, "Ok, set"), null);
    assert.equal(await kanboardDoCompletions(board, "what about the docs?"), null);
    assert.equal(await kanboardDoCompletions(board, "set"), null, "a word that matches no id prefix yields nothing");
    assert.equal(await kanboardDoCompletions(board, "UNI-1 "), null, "trailing space = a new word is coming");
    assert.equal(await kanboardDoCompletions(board, "write a note"), null);
  });

  it("an id prefix lists matching ids with title labels and status descriptions", async () => {
    const items = (await kanboardDoCompletions(board, "UNI-1")) ?? [];
    assert.deepEqual(items.map(row), ["UNI-12|UNI-12  Skill settings|todo"]);
  });

  it("a trailing id token after prose keeps the earlier words in the value", async () => {
    const items = (await kanboardDoCompletions(board, "work UNI-1")) ?? [];
    assert.deepEqual(items.map((item) => item.value), ["work UNI-12"]);
    assert.deepEqual(items.map(row), ["work UNI-12|UNI-12  Skill settings|todo"]);
  });

  it("a bare prefix lists ids only — titles never pull in unrelated tasks", async () => {
    const items = (await kanboardDoCompletions(board, "UNI")) ?? [];
    assert.deepEqual(
      items.map((item) => item.value),
      ["UNI-12", "UNI-3"],
    );
    assert.ok(items.every((item) => item.description === "todo" || item.description === "in_progress"));
    assert.equal(
      items.some((item) => item.label.includes("unify")),
      false,
      "SWARM-2 'unify the docs' must not match the UNI prefix",
    );
  });

  it("lowercase and dash-only prefixes work; cancelled tasks stay hidden", async () => {
    const uni = (await kanboardDoCompletions(board, "uni")) ?? [];
    assert.deepEqual(uni.map((item) => item.value), ["UNI-12", "UNI-3"]);
    const dash = (await kanboardDoCompletions(board, "UNI-")) ?? [];
    assert.deepEqual(dash.map((item) => item.value), ["UNI-12", "UNI-3"]);
    assert.equal(((await kanboardDoCompletions(board, "OLD")) ?? []).length, 0, "cancelled excluded");
  });
});
