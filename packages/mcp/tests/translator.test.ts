import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeJsonSchema,
  compareCodeUnits,
  translateMcpTool,
} from "../src/bridge/translator.js";

const client = {
  async callTool() {
    return { content: [] };
  },
};

test("canonicalizeJsonSchema recursively sorts keys and only normalizes valid required arrays", () => {
  const schema = {
    z: 1,
    required: ["z", "a", "z"],
    properties: {
      list: {
        anyOf: [
          { required: ["b", "a", "b"], z: true, a: true },
          { enum: ["z", "a", "z"] },
        ],
      },
      invalid: { required: ["b", 1, "a"] },
    },
    const: { required: ["z", "a"] },
    examples: [{ z: 1, a: 2, required: ["z", "a"] }, { b: 3, a: 4 }],
  };
  const original = structuredClone(schema);

  const canonical = canonicalizeJsonSchema(schema) as Record<string, any>;

  assert.deepEqual(schema, original, "input must not be mutated");
  assert.notStrictEqual(canonical, schema);
  assert.deepEqual(Object.keys(canonical), ["const", "examples", "properties", "required", "z"]);
  assert.deepEqual(canonical.required, ["a", "z"]);
  assert.deepEqual(canonical.properties.list.anyOf[0].required, ["a", "b"]);
  assert.deepEqual(canonical.properties.list.anyOf[1].enum, ["z", "a", "z"]);
  assert.deepEqual(canonical.properties.invalid.required, ["b", 1, "a"]);
  assert.deepEqual(canonical.const.required, ["z", "a"]);
  assert.deepEqual(canonical.examples[0].required, ["z", "a"]);
  assert.deepEqual(canonical.examples.map((item: object) => Object.keys(item)), [
    ["a", "required", "z"],
    ["a", "b"],
  ]);
});

test("code-unit comparison is locale independent", () => {
  const values = ["ä", "Z", "a", "A", "😀"];
  assert.deepEqual([...values].sort(compareCodeUnits), ["A", "Z", "a", "ä", "😀"]);
});

test("translated tools have deterministic labels and canonical Pi-facing schemas", () => {
  const inputSchema = {
    description: "input",
    properties: {
      z: { type: "string" },
      a: { type: "number" },
    },
    additionalProperties: false,
  };
  const original = structuredClone(inputSchema);

  const translated = translateMcpTool(
    { name: "find", description: "Find things", inputSchema },
    "search",
    client,
  );

  assert.equal(translated.name, "search__find");
  assert.equal(translated.label, "search__find");
  assert.deepEqual(Object.keys(translated.parameters), ["properties", "required", "type"]);
  assert.deepEqual(Object.keys(translated.parameters.properties), ["a", "z"]);
  assert.deepEqual(translated.parameters.required, []);
  assert.deepEqual(inputSchema, original, "translation must not mutate MCP schema");
});
