import { describe, it, expect } from "bun:test";
import { askAnswers } from "../src/compaction/source.js";

describe("askAnswers", () => {
  it("turns a multi-question ask_user result into Q → A lines, skipping skipped ones", () => {
    const message = {
      role: "toolResult",
      toolName: "ask_user",
      content: [{ type: "text", text: "User answered your questions:\n{}" }],
      details: {
        questions: [
          { question: "Which database?", header: "DB", options: [{ label: "Postgres", value: "pg" }, { label: "SQLite" }] },
          { question: "Which port?", header: "Port", options: [] },
          { question: "Features?", header: "Features", options: [{ label: "Search" }] },
        ],
        answers: [
          { selected: ["pg"], skipped: false },
          { selected: [], skipped: true },
          { selected: ["Search"], custom_text: "and tags", skipped: false },
        ],
      },
    };
    expect(askAnswers(message)).toEqual(["Which database? → Postgres", "Features? → Search, and tags"]);
  });

  it("still reads the older single-question text", () => {
    expect(askAnswers({ content: [{ type: "text", text: "User selected: Postgres" }], details: { question: "Which DB?" } })).toEqual(["Which DB? → Postgres"]);
  });
});
