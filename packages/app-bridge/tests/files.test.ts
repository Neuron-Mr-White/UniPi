import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSuggestions, findFd } from "../src/files.js";

describe("@ file suggestions", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-files-"));
  mkdirSync(join(root, "src/chat"), { recursive: true });
  mkdirSync(join(root, "my dir"));
  writeFileSync(join(root, "src/chat/ChatView.tsx"), "x");
  writeFileSync(join(root, "README.md"), "x");
  writeFileSync(join(root, "my dir/notes.md"), "x");

  it("finds files by name, with pi's completion value", async () => {
    const items = await fileSuggestions(root, "chatv");
    const hit = items.find((i) => i.label === "ChatView.tsx");
    assert.ok(hit, JSON.stringify(items));
    assert.equal(hit.value, "@src/chat/ChatView.tsx");
    assert.equal(hit.dir, false);
  });
  it("marks directories and quotes paths with spaces", async () => {
    const items = await fileSuggestions(root, "my");
    const dir = items.find((i) => i.dir && i.label.startsWith("my dir"));
    assert.ok(dir, JSON.stringify(items));
    assert.equal(dir.value, '@"my dir/"');
  });
  it("an empty query lists the top level", async () => {
    const items = await fileSuggestions(root, "");
    assert.ok(items.some((i) => i.label === "README.md"), JSON.stringify(items));
  });
  it("uses fd when there is one", () => {
    console.log("fd:", findFd());
  });
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
});
