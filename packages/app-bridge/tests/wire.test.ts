import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineSplitter, parseIn } from "../src/wire.js";
import { clipText, fitLine, historyPage, jsonBytes, LINE_BUDGET, phoneSafe, snapshotEntries, wantedEntry } from "../src/snapshot.js";
import { DialogHub, wrapUi } from "../src/dialogs.js";

describe("parseIn", () => {
  it("accepts prompts with a default auto mode and keeps the ref", () => {
    assert.deepEqual(parseIn('{"t":"prompt","text":"hi","ref":"r1"}'), { t: "prompt", text: "hi", images: undefined, mode: "auto", ref: "r1" });
    assert.equal((parseIn('{"t":"prompt","text":"x","mode":"followUp"}') as { mode: string }).mode, "followUp");
  });
  it("rejects empty prompts, unknown types and garbage without throwing", () => {
    assert.deepEqual(parseIn('{"t":"prompt","text":"  "}'), { bad: "prompt is empty", ref: undefined });
    assert.equal((parseIn('{"t":"rm -rf"}') as { bad: string }).bad, "unknown type rm -rf");
    assert.deepEqual(parseIn("nope"), { bad: "not JSON" });
    assert.equal(parseIn("   "), undefined);
  });
  it("keeps only image attachments", () => {
    const m = parseIn('{"t":"prompt","text":"","images":[{"mime":"image/png","data":"AA=="},{"mime":"text/plain","data":"x"}]}') as { images: unknown[] };
    assert.equal(m.images.length, 1);
  });
  it("validates answer / set_model / set_thinking", () => {
    assert.deepEqual(parseIn('{"t":"answer","id":3,"value":"b"}'), { t: "answer", id: 3, value: "b", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"answer","id":"3"}') as object));
    assert.ok("bad" in (parseIn('{"t":"set_model","provider":"x"}') as object));
    assert.deepEqual(parseIn('{"t":"set_thinking","level":"high"}'), { t: "set_thinking", level: "high", ref: undefined });
  });
});

describe("LineSplitter", () => {
  it("splits across chunks and drops over-long lines", () => {
    const s = new LineSplitter(10);
    assert.deepEqual(s.push('{"a":'), []);
    assert.deepEqual(s.push('1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(s.push("x".repeat(20)), []);
    assert.deepEqual(s.push("yyy\nok\n"), ["ok"]);
  });
});

describe("snapshot", () => {
  it("replaces images and clips long text", () => {
    const safe = phoneSafe({ role: "user", content: [{ type: "image", data: "A".repeat(4000), mimeType: "image/png" }, { type: "text", text: "x".repeat(100) }] }, 50) as any;
    assert.deepEqual(safe.content[0], { type: "image", mime: "image/png", omitted: true, bytes: 3000 });
    assert.match(safe.content[1].text, /clipped 50 chars/);
    assert.equal(clipText("short", 10), "short");
  });
  it("starts at the latest compaction and drops state-only entries", () => {
    const branch = [
      { type: "message", id: "a" },
      { type: "compaction", id: "c" },
      { type: "custom", customType: "unipi:auto-name", id: "n" },
      { type: "message", id: "b" },
      { type: "label", id: "l" },
    ];
    const { entries, truncated } = snapshotEntries(branch);
    assert.deepEqual(entries.map((e: any) => e.id), ["c", "b"]);
    assert.equal(truncated, true);
    assert.equal(wantedEntry({ type: "custom", customType: "unipi-command-echo" }), true);
  });
  it("trims from the oldest end to fit the budget", () => {
    const branch = Array.from({ length: 10 }, (_, i) => ({ type: "message", id: String(i), message: { role: "user", content: "x".repeat(1000) } }));
    const { entries, truncated } = snapshotEntries(branch, 3500);
    assert.ok(entries.length < 10 && entries.length >= 2);
    assert.equal((entries.at(-1) as any).id, "9");
    assert.equal(truncated, true);
  });
  it("fitLine never exceeds the budget", () => {
    const line = fitLine({ t: "entry", entry: { a: "x".repeat(LINE_BUDGET * 2) } });
    assert.ok(line.length <= LINE_BUDGET);
  });
});

describe("DialogHub", () => {
  const events: string[] = [];
  const hub = new DialogHub({ open: (d) => events.push(`open:${d.id}:${d.kind}`), close: (id, by) => events.push(`close:${id}:${by}`) });

  it("phone answer wins and aborts the TUI side", async () => {
    let tuiAborted = false;
    const p = hub.race(
      { kind: "select", title: "t", options: ["a", "b"] },
      (signal) => new Promise<string | undefined>((resolve) => signal.addEventListener("abort", () => { tuiAborted = true; resolve(undefined); })),
      (v) => String(v),
    );
    assert.equal(hub.list().length, 1);
    assert.equal(hub.answer(hub.list()[0]!.id, "b"), true);
    assert.equal(await p, "b");
    assert.equal(tuiAborted, true);
    assert.equal(hub.list().length, 0);
    assert.equal(hub.answer(1, "a"), false, "second answer is refused");
  });

  it("TUI answer wins and tells the phone", async () => {
    events.length = 0;
    const p = hub.race({ kind: "confirm", title: "ok?" }, async () => true, (v) => v === true);
    assert.equal(await p, true);
    assert.deepEqual(events, ["open:2:confirm", "close:2:tui"]);
  });

  it("null from the phone is a cancel", async () => {
    events.length = 0;
    const p = hub.race({ kind: "input" }, (signal) => new Promise<string | undefined>((r) => signal.addEventListener("abort", () => r(undefined))), (v) => (v === null ? undefined : String(v)));
    hub.answer(3, null);
    assert.equal(await p, undefined);
    assert.deepEqual(events, ["open:3:input", "close:3:cancel"]);
  });

  it("wrapUi wraps once and passes a signal to the original", async () => {
    let seenSignal: AbortSignal | undefined;
    const ui = {
      select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) => {
        seenSignal = opts?.signal;
        return new Promise<string | undefined>((r) => opts?.signal?.addEventListener("abort", () => r(undefined)));
      },
    };
    const h = new DialogHub({ open: () => {}, close: () => {} });
    wrapUi(ui, h);
    const first = ui.select;
    wrapUi(ui, h);
    assert.equal(ui.select, first, "idempotent");
    const p = ui.select("pick", ["x", "y"]);
    assert.ok(seenSignal);
    h.answer(h.list()[0]!.id, "zzz");
    assert.equal(await p, undefined, "unknown option from the phone = no pick");
  });
});

describe("entry filter", () => {
  it("drops the system prompt, hidden custom messages and context-edited entries", () => {
    const branch = [
      { type: "message", id: "s", message: { role: "system", content: "huge" } },
      { type: "message", id: "u", message: { role: "user", content: "hi" } },
      { type: "custom_message", id: "c", customType: "unipi-continue", content: "", display: false },
      { type: "custom_message", id: "r", customType: "unipi-memory-recall-reminder", content: "x", display: true },
      { type: "message", id: "gone", message: { role: "assistant", content: [] } },
      { type: "context_edit", id: "e", targetId: "gone", replacement: null },
      { type: "thinking_level_change", id: "t", thinkingLevel: "high" },
    ];
    assert.deepEqual(snapshotEntries(branch).entries.map((e: any) => e.id), ["u", "r"]);
  });
});

describe("details slimming (hello too large, 2026-10-07)", () => {
  it("drops run logs from details, keeps the fields the phone shows", () => {
    const e = {
      type: "custom_message",
      id: "x",
      customType: "sidekick-completion",
      content: "done",
      details: { status: "completed", durationMs: 88019, usage: { cost: 0.06 }, text: "## Result", events: Array.from({ length: 400 }, (_, i) => ({ kind: "tool", output: "y".repeat(300), i })) },
    };
    const safe = phoneSafe(e) as any;
    assert.equal(safe.details.events, undefined);
    assert.equal(safe.details.status, "completed");
    assert.equal(safe.details.text, "## Result");
    assert.ok(JSON.stringify(safe).length < 2000);
  });
  it("caps tool-result details and keeps every snapshot under the entries budget in UTF-8 bytes", () => {
    const branch = Array.from({ length: 40 }, (_, i) => ({
      type: "message",
      id: String(i),
      message: { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "é".repeat(20000) }], details: { diff: "z".repeat(100000), exitCode: 0 } },
    }));
    const { entries, truncated } = snapshotEntries(branch, 300 * 1024);
    assert.ok(jsonBytes(entries) <= 300 * 1024);
    assert.equal(truncated, true);
    assert.equal((entries.at(-1) as any).message.details.diff, undefined);
    assert.equal((entries.at(-1) as any).message.details.exitCode, 0);
  });
});

describe("history paging", () => {
  const branch = [
    { type: "message", id: "a", message: { role: "user", content: "x".repeat(400) } },
    { type: "message", id: "s", message: { role: "system", content: "sys" } },
    { type: "compaction", id: "c", summary: "sum" },
    { type: "message", id: "b", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(400) }] } },
    { type: "message", id: "d", message: { role: "user", content: "z" } },
  ];
  it("returns the newest entries before `before`, through compactions, oldest first", () => {
    const page = historyPage(branch, "d", 10_000);
    assert.deepEqual(page.entries.map((e: any) => e.id), ["a", "c", "b"]);
    assert.equal(page.more, false);
  });
  it("pages by budget and reports more", () => {
    const page = historyPage(branch, "d", 600);
    assert.deepEqual(page.entries.map((e: any) => e.id), ["c", "b"]);
    assert.equal(page.more, true);
    const next = historyPage(branch, "c", 600);
    assert.deepEqual(next.entries.map((e: any) => e.id), ["a"]);
    assert.equal(next.more, false);
  });
  it("unknown or first entry → empty", () => {
    assert.deepEqual(historyPage(branch, "nope"), { entries: [], more: false });
    assert.deepEqual(historyPage(branch, "a"), { entries: [], more: false });
  });
  it("parses the history request", () => {
    assert.deepEqual(parseIn('{"t":"history","before":"e1","ref":"h"}'), { t: "history", before: "e1", ref: "h" });
    assert.ok("bad" in (parseIn('{"t":"history"}') as object));
  });
});
