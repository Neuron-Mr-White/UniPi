/**
 * @pi-unipi/utility — /unipi:answer extraction, template round-trip, web form
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTemplate, composeAnswers, extractQuestions, messageText, parseTemplate } from "../src/answer/extract.ts";
import { renderReply, startWebForm } from "../src/answer/web.ts";
import { isSsh } from "../src/answer/index.ts";

const REPLY = `Here is the plan.

1. **Should I start Phase 1?**
- Do you want your global skills mode changed now?

\`\`\`ts
const x = a ? b : c; // not a question?
\`\`\`

See https://example.com/page?x=1 for details.
Where did you see the tag? A screenshot helps.`;

describe("extractQuestions", () => {
  it("takes question lines outside code, markers stripped, URLs ignored", () => {
    assert.deepEqual(extractQuestions(REPLY), [
      "Should I start Phase 1?",
      "Do you want your global skills mode changed now?",
      "Where did you see the tag? A screenshot helps.",
    ]);
  });
  it("reads assistant content arrays", () => {
    assert.equal(messageText([{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  });
});

describe("template round-trip", () => {
  it("is only Q/A pairs, and parses multi-line answers (a # line is kept as text)", () => {
    const qs = ["Start?", "Change mode?", "Where?"];
    const t = buildTemplate(qs);
    assert.equal(t, "Q1. Start?\nA1: \n\nQ2. Change mode?\nA2: \n\nQ3. Where?\nA3: ");
    const filled = t.replace("A1: ", "A1: yes, go\n# and commit per phase").replace("A3: ", "A3: in the dva model");
    assert.deepEqual(parseTemplate(filled, 3), ["yes, go\n# and commit per phase", "", "in the dva model"]);
  });

  it("composes quoted answers and lists the skipped ones", () => {
    const msg = composeAnswers(["Start?", "Change mode?"], ["yes", ""], "thanks");
    assert.equal(msg, "1. > Start?\n\nyes\n\nthanks\n\n(Not answered: #2)");
    assert.equal(composeAnswers(["Start?"], [""]), undefined);
  });

  it("handles a reply with no questions as free text", () => {
    assert.equal(buildTemplate([]), "");
    assert.equal(parseTemplate("just do it\n", 0)[0], "just do it");
    assert.equal(composeAnswers([], ["just do it"]), "just do it");
  });
});

describe("web form", () => {
  it("serves the page behind a token and resolves on submit", async () => {
    const form = await startWebForm(REPLY, ["Start?", "Where?"], 0);
    try {
      const page = await (await fetch(form.url)).text();
      assert.match(page, /Should I start Phase 1\?/);
      assert.equal((await fetch(form.url.replace(/\/a\/\w+$/, "/a/wrong"))).status, 404);
      const res = await fetch(form.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers: ["yes", "here"], note: "n" }) });
      assert.equal(res.status, 200);
      assert.deepEqual(await form.result, { answers: ["yes", "here"], note: "n" });
    } finally {
      form.close();
    }
  });

  it("renders markdown tables", () => {
    assert.match(renderReply("| A | B |\n|---|---|\n| 1 | 2 |"), /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  });

  it("escapes HTML in the rendered reply", () => {
    assert.match(renderReply("<script>x</script> **b**"), /&lt;script&gt;x&lt;\/script&gt; <b>b<\/b>/);
  });

  it("detects SSH sessions", () => {
    assert.equal(isSsh({ SSH_CONNECTION: "1 2 3 4" }), true);
    assert.equal(isSsh({}), false);
  });
});
