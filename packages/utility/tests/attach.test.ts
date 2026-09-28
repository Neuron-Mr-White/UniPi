/**
 * @pi-unipi/utility — attachment detection, tokens and submit expansion
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expandForSubmit, findPaths, stillReferenced, tokenize } from "../src/attach/detect.ts";

const yes = () => true;

describe("findPaths", () => {
  it("finds pasted, quoted, escaped, file:// and ~ paths with known extensions", () => {
    const text = "look at /tmp/pi-clipboard-1a2b.png and '/home/u/My Shots/a b.jpg' plus /home/u/Docs/spec\\ v2.pdf and file:///home/u/x%20y.webp ~/notes/todo.md /usr/bin/node";
    const found = findPaths(text, yes);
    assert.deepEqual(found.map((f) => [f.path, f.kind]), [
      ["/tmp/pi-clipboard-1a2b.png", "image"],
      ["/home/u/My Shots/a b.jpg", "image"],
      ["/home/u/Docs/spec v2.pdf", "file"],
      ["/home/u/x y.webp", "image"],
      [`${homedir()}/notes/todo.md`, "file"],
    ]);
  });
  it("ignores paths that do not exist", () => {
    assert.deepEqual(findPaths("/nope/missing.png", () => false), []);
  });
});

describe("tokenize", () => {
  it("replaces paths with numbered tokens and keeps numbering across pastes", () => {
    const first = tokenize("fix /tmp/a.png please", [], () => 2048, yes);
    assert.equal(first.text, "fix [Image #1] please");
    const second = tokenize(`${first.text} and /tmp/spec.pdf and /tmp/a.png`, first.added, () => 10, yes);
    assert.equal(second.text, "fix [Image #1] please and [File #2] and [Image #1]");
    assert.deepEqual(second.added.map((a) => a.id), [2]);
  });
  it("drops attachments whose token was deleted", () => {
    const { added } = tokenize("/tmp/a.png /tmp/b.png", [], () => 1, yes);
    assert.deepEqual(stillReferenced("only [Image #2] now", added).map((a) => a.name), ["b.png"]);
  });
});

describe("expandForSubmit", () => {
  it("sends images as image content in token order and expands file tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-attach-"));
    const a = join(dir, "a.png");
    const b = join(dir, "b.jpg");
    const doc = join(dir, "spec.pdf");
    writeFileSync(a, "AAA");
    writeFileSync(b, "BBB");
    writeFileSync(doc, "%PDF");
    const { text: t, added } = tokenize(`${b} then ${a} and ${doc}`, []);
    const out = expandForSubmit(t, added);
    assert.equal(out.text, `[Image #1] then [Image #2] and [File #3: ${doc}]`);
    assert.deepEqual(out.images.map((i) => [Buffer.from(i.data, "base64").toString(), i.mimeType]), [["BBB", "image/jpeg"], ["AAA", "image/png"]]);
  });
});
