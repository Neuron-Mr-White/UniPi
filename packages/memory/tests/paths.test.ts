import { test } from "node:test";
import assert from "node:assert/strict";
import {
  idFromTitle,
  legacySourceUri,
  mempalaceYaml,
  projectName,
  quoteUriPart,
  sanitizeProjectName,
} from "../paths.js";

test("projectName matches agent_gate sanitize_project_name", () => {
  assert.equal(projectName("/home/user/My Project"), "my_project");
  assert.equal(projectName("/home/user/kb-live"), "kb_live");
  assert.equal(projectName("/home/user/KB Live!"), "kb_live");
  assert.equal(projectName("/"), "unknown");
  assert.equal(projectName("/a/___"), "unknown");
  assert.equal(projectName("/x/Café"), "caf");
  assert.equal(projectName("/x/a.b.c"), "a_b_c");
});

test("idFromTitle unchanged rule", () => {
  assert.equal(idFromTitle("Auth JWT Refresh Tokens"), "auth_jwt_refresh_tokens");
  assert.equal(idFromTitle("hello!"), "hello_");
  assert.equal(idFromTitle("a/b"), "a_b");
});

test("quoteUriPart mirrors Python ord()->%XX", () => {
  assert.equal(quoteUriPart("abc_def-1.2~3"), "abc_def-1.2~3");
  assert.equal(quoteUriPart("My Project"), "My%20Project");
  assert.equal(quoteUriPart("café"), "caf%E9"); // ord('é')=233 -> %E9, not UTF-8 bytes
  assert.equal(quoteUriPart("日本"), "%65E5%672C"); // multi-byte codepoints
  assert.equal(quoteUriPart("UPPER+plus"), "UPPER%2Bplus");
  assert.equal(quoteUriPart("a/b"), "a%2Fb");
  assert.equal(legacySourceUri("My Project", "id 1"), "unipi://memory/My%20Project/id%201");
});

test("mempalaceYaml has wing + 5 rooms", () => {
  const y = mempalaceYaml("conc");
  assert.match(y, /^wing: conc/m);
  for (const r of ["preference", "decision", "pattern", "summary", "general"]) {
    assert.match(y, new RegExp(`name: ${r}\\b`), r);
  }
});
