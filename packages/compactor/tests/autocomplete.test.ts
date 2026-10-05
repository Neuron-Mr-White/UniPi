import { describe, expect, it } from "bun:test";
import { createCompactThenAutocompleteProvider } from "../src/index.js";

function baseProvider(items: Array<{ value: string; label: string; description?: string }>) {
  return {
    async getSuggestions() {
      return items.length === 0 ? null : { items, prefix: "" };
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: unknown, prefix: string) {
      return { lines, cursorLine, cursorCol };
    },
  } as any;
}

describe("createCompactThenAutocompleteProvider", () => {
  it("adds the synthetic unipi:compact-then item when the query matches", async () => {
    const provider = createCompactThenAutocompleteProvider(baseProvider([{ value: "unipi:compact-vcc", label: "unipi:compact-vcc" }]));
    const result = await provider.getSuggestions(["/unipi:compact-t"], 0, 17, { signal: new AbortController().signal });
    expect(result?.items.map((i) => i.value)).toEqual(["unipi:compact-vcc", "unipi:compact-then"]);
  });

  it("matches the short name too, e.g. /compact-then", async () => {
    const provider = createCompactThenAutocompleteProvider(baseProvider([]));
    const result = await provider.getSuggestions(["/compact-then"], 0, 14, { signal: new AbortController().signal });
    expect(result?.items.map((i) => i.value)).toEqual(["unipi:compact-then"]);
  });

  it("does not add the item for an unrelated query", async () => {
    const provider = createCompactThenAutocompleteProvider(baseProvider([{ value: "unipi:settings", label: "unipi:settings" }]));
    const result = await provider.getSuggestions(["/settings"], 0, 9, { signal: new AbortController().signal });
    expect(result?.items.map((i) => i.value)).toEqual(["unipi:settings"]);
  });

  it("does not intercept argument position (text contains a space)", async () => {
    const provider = createCompactThenAutocompleteProvider(baseProvider([]));
    const result = await provider.getSuggestions(["/unipi:compact-then do the thing"], 0, 33, { signal: new AbortController().signal });
    expect(result).toBeNull();
  });

  it("leaves non-slash text untouched", async () => {
    const provider = createCompactThenAutocompleteProvider(baseProvider([{ value: "unipi:settings", label: "unipi:settings" }]));
    const result = await provider.getSuggestions(["hello"], 0, 5, { signal: new AbortController().signal });
    expect(result?.items.map((i) => i.value)).toEqual(["unipi:settings"]);
  });
});
