import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMemoryTools, MEMORY_TOOLS } from "../tools.js";

interface RegisteredTool {
  name: string;
  description?: string;
  promptGuidelines?: string[];
}

function toolsWith(neutral: boolean): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  const pi = {
    registerTool: (def: RegisteredTool) => { registered.set(def.name, def); },
    getActiveTools: () => Object.values(MEMORY_TOOLS) as string[],
    setActiveTools: (_: string[]) => {},
    appendEntry: () => {},
    on: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    setStatus: () => {},
  } as never;
  registerMemoryTools(pi, () => null, undefined, { neutral });
  return registered;
}

test("recallAtStart off → neutral wording, tools still registered", () => {
  const tools = toolsWith(true);
  const search = tools.get(MEMORY_TOOLS.SEARCH)!;
  assert.equal(search.description?.includes("IMPORTANT"), false);
  for (const g of search.promptGuidelines ?? []) assert.equal(g.includes("IMPORTANT"), false);
  for (const name of Object.values(MEMORY_TOOLS)) assert.ok(tools.has(name), `${name} registered`);
});

test("recallAtStart on → strong wording", () => {
  const tools = toolsWith(false);
  const search = tools.get(MEMORY_TOOLS.SEARCH)!;
  assert.match(search.description ?? "", /IMPORTANT/);
});
