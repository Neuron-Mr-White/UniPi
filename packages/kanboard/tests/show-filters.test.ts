import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kanboardCompletions, renderShowPlain, showRenderer, registerKanboardCommands } from "../src/commands.js";

const lanes = ["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled", "archived"];
const tasks = lanes.map((status, index) => ({ id: `UNI-${index + 1}`, title: `${status} task`, status }));
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

describe("show lane filters", () => {
  it("completes every lane and --all, preserving the full argument prefix", () => {
    assert.deepEqual(kanboardCompletions("show ")!.map((item) => item.value), [...lanes, "--all"].map((lane) => `show ${lane}`));
    assert.deepEqual(kanboardCompletions("show in_")!.map((item) => item.value), ["show in_progress", "show in_review"]);
    assert.deepEqual(kanboardCompletions("show ar")!.map((item) => item.value), ["show archived"]);
    assert.deepEqual(kanboardCompletions("show --")!.map((item) => item.value), ["show --all"]);
  });

  it("requests --all data and filters hidden lanes in the command handler", async (t) => {
    t.mock.method(process, "cwd", () => "/tmp");
    const previous = process.env.UNIPI_KANBOARD_PROJECT;
    process.env.UNIPI_KANBOARD_PROJECT = "project";
    t.after(() => {
      if (previous === undefined) delete process.env.UNIPI_KANBOARD_PROJECT;
      else process.env.UNIPI_KANBOARD_PROJECT = previous;
    });
    let handler: (args: string, ctx: never) => Promise<void>;
    const messages: Array<{ details: { tasks: typeof tasks; lane: string }; content: string }> = [];
    const calls: string[][] = [];
    registerKanboardCommands({
      registerCommand: (name: string, options: { handler: typeof handler }) => { if (name === "unipi:kanboard") handler = options.handler; },
      on: () => {},
      sendMessage: (message: typeof messages[number]) => messages.push(message),
    } as never, {
      cli: { run: async (args: string[]) => { calls.push(args); return { tasks }; } },
      guard: {},
      settings: () => ({}),
    } as never);
    await handler!("show archived", { cwd: "/tmp", ui: { notify: () => {} } } as never);
    assert.deepEqual(calls, [["list", "--all", "--json"]]);
    assert.equal(messages[0]!.details.lane, "archived");
    assert.deepEqual(messages[0]!.details.tasks, tasks.filter((task) => task.status === "archived"));
    assert.match(messages[0]!.content, /archived task/);
  });

  for (const lane of lanes) {
    it(`shows only ${lane}, including normally hidden lanes`, () => {
      const text = renderShowPlain("project", tasks, false, lane);
      assert.match(text, /project · 1 tasks/);
      assert.ok(text.includes(`${lane} task`));
      for (const other of lanes.filter((other) => other !== lane)) assert.ok(!text.includes(`${other} task`));
      const filtered = tasks.filter((task) => task.status === lane);
      const rendered = showRenderer({ content: text, details: { project: "project", tasks: filtered, lane } }, {}, theme).render(100).join("\n");
      assert.ok(rendered.includes(`${lane} task`));
      assert.equal(rendered.split("\n").length, 3);
    });
  }
});
