import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LineSplitter, parseIn } from "../src/wire.js";
import { clipText, fitLine, historyPage, jsonBytes, LINE_BUDGET, phoneSafe, snapshotEntries, wantedEntry } from "../src/snapshot.js";
import { DialogHub, wrapUi } from "../src/dialogs.js";

describe("parseIn", () => {
  it("accepts prompts with a default auto mode and keeps the ref", () => {
    assert.deepEqual(parseIn('{"t":"prompt","text":"hi","ref":"r1"}'), { t: "prompt", text: "hi", images: undefined, mode: "auto", ref: "r1" });
    assert.equal((parseIn('{"t":"prompt","text":"x","mode":"followUp"}') as { mode: string }).mode, "followUp");
    assert.equal((parseIn('{"t":"prompt","text":"x","mode":"now"}') as { mode: string }).mode, "now");
    assert.equal((parseIn('{"t":"prompt","text":"x","mode":"after"}') as { mode: string }).mode, "after");
    assert.equal((parseIn('{"t":"prompt","text":"x","mode":"bogus"}') as { mode: string }).mode, "auto");
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
  it("accepts path-based images (blob-channel uploads) alongside inline data", () => {
    const m = parseIn('{"t":"prompt","text":"","images":[{"mime":"image/jpeg","path":"/tmp/x.jpg"},{"mime":"image/png","data":"AA=="}]}') as { images: unknown[] };
    assert.equal(m.images.length, 2);
    assert.deepEqual(m.images[0], { mime: "image/jpeg", path: "/tmp/x.jpg" });
  });
  it("validates answer / set_model / set_thinking", () => {
    assert.deepEqual(parseIn('{"t":"answer","id":3,"value":"b"}'), { t: "answer", id: 3, value: "b", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"answer","id":"3"}') as object));
    assert.ok("bad" in (parseIn('{"t":"set_model","provider":"x"}') as object));
    assert.deepEqual(parseIn('{"t":"set_thinking","level":"high"}'), { t: "set_thinking", level: "high", ref: undefined });
  });
  it("validates sessions / session_new / session_resume / session_fork / tree / tree_go / session_rename", () => {
    assert.deepEqual(parseIn('{"t":"sessions","scope":"cwd"}'), { t: "sessions", scope: "cwd", query: undefined, ref: undefined });
    assert.deepEqual(parseIn('{"t":"sessions","scope":"all","query":"bug"}'), { t: "sessions", scope: "all", query: "bug", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"sessions","scope":"nope"}') as object));
    assert.deepEqual(parseIn('{"t":"session_new"}'), { t: "session_new", force: false, ref: undefined });
    assert.deepEqual(parseIn('{"t":"session_new","force":true}'), { t: "session_new", force: true, ref: undefined });
    assert.deepEqual(parseIn('{"t":"session_resume","path":"/a/b.jsonl"}'), { t: "session_resume", path: "/a/b.jsonl", force: false, ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"session_resume"}') as object));
    assert.deepEqual(parseIn('{"t":"session_fork","entryId":"m2"}'), { t: "session_fork", entryId: "m2", force: false, ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"session_fork"}') as object));
    assert.deepEqual(parseIn('{"t":"tree","ref":"t1"}'), { t: "tree", ref: "t1" });
    assert.deepEqual(parseIn('{"t":"tree_go","id":"m1"}'), { t: "tree_go", id: "m1", summarize: false, force: false, ref: undefined });
    assert.deepEqual(parseIn('{"t":"tree_go","id":"m1","summarize":true,"force":true}'), { t: "tree_go", id: "m1", summarize: true, force: true, ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"tree_go"}') as object));
    assert.deepEqual(parseIn('{"t":"session_rename","name":"new name"}'), { t: "session_rename", name: "new name", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"session_rename"}') as object));
  });
  it("validates btw / btw_list / queue_edit / queue_remove / queue_promote / queue_move", () => {
    assert.deepEqual(parseIn('{"t":"btw","question":"why?"}'), { t: "btw", question: "why?", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"btw","question":"  "}') as object));
    assert.ok("bad" in (parseIn('{"t":"btw"}') as object));
    assert.deepEqual(parseIn('{"t":"btw_list","ref":"bl"}'), { t: "btw_list", ref: "bl" });
    assert.deepEqual(parseIn('{"t":"queue_edit","id":"q1","text":"new text"}'), { t: "queue_edit", id: "q1", text: "new text", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"queue_edit","id":"q1"}') as object));
    assert.deepEqual(parseIn('{"t":"queue_remove","id":"q1"}'), { t: "queue_remove", id: "q1", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"queue_remove"}') as object));
    assert.deepEqual(parseIn('{"t":"queue_promote","id":"q1","to":"now"}'), { t: "queue_promote", id: "q1", to: "now", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"queue_promote","id":"q1","to":"later"}') as object));
    assert.deepEqual(parseIn('{"t":"queue_move","id":"q1","index":2}'), { t: "queue_move", id: "q1", index: 2, ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"queue_move","id":"q1"}') as object));
  });

  it("validates set_fusion / watch / work_* (UNI-160)", () => {
    assert.deepEqual(parseIn('{"t":"set_fusion","single":"p/m","effort":"high"}'), { t: "set_fusion", single: "p/m", effort: "high", ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"set_fusion","single":"p/m"}') as object));
    assert.deepEqual(
      parseIn('{"t":"set_fusion","lead":"p/l","sidekick":"p/s","leadEffort":"high","sidekickEffort":"low"}'),
      { t: "set_fusion", lead: "p/l", sidekick: "p/s", leadEffort: "high", sidekickEffort: "low", ref: undefined },
    );
    assert.ok("bad" in (parseIn('{"t":"set_fusion","lead":"p/l","sidekick":"p/s"}') as object));
    assert.ok("bad" in (parseIn('{"t":"set_fusion"}') as object));
    assert.deepEqual(parseIn('{"t":"watch","stats":true}'), { t: "watch", stats: true, info: undefined, ref: undefined });
    assert.deepEqual(parseIn('{"t":"watch","info":false}'), { t: "watch", stats: undefined, info: false, ref: undefined });
    assert.deepEqual(parseIn('{"t":"work_log","id":"bg-1","before":200}'), { t: "work_log", id: "bg-1", before: 200, ref: undefined });
    assert.ok("bad" in (parseIn('{"t":"work_log"}') as object));
    assert.deepEqual(parseIn('{"t":"work_transcript","id":"agent-1"}'), { t: "work_transcript", id: "agent-1", ref: undefined });
    assert.deepEqual(parseIn('{"t":"work_stop","id":"bg-1"}'), { t: "work_stop", id: "bg-1", ref: undefined });
    assert.deepEqual(parseIn('{"t":"work_rerun","id":"bg-1"}'), { t: "work_rerun", id: "bg-1", ref: undefined });
    assert.deepEqual(parseIn('{"t":"work_background","id":"agent-1"}'), { t: "work_background", id: "agent-1", ref: undefined });
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
  it("inlines small images whole and clips long text", () => {
    const safe = phoneSafe({ role: "user", content: [{ type: "image", data: "A".repeat(4000), mimeType: "image/png" }, { type: "text", text: "x".repeat(100) }] }, 50) as any;
    assert.deepEqual(safe.content[0], { type: "image", mime: "image/png", omitted: false, bytes: 3000, data: "A".repeat(4000) });
    assert.match(safe.content[1].text, /clipped 50 chars/);
    assert.equal(clipText("short", 10), "short");
  });
  it("big images get a mediaRef instead of the bytes", () => {
    const big = "A".repeat(40000); // > INLINE_THUMBNAIL_MAX (24 KiB) chars of base64
    const safe = phoneSafe({ role: "user", content: [{ type: "image", data: big, mimeType: "image/jpeg" }] }) as any;
    const img = safe.content[0];
    assert.equal(img.type, "image");
    assert.equal(img.omitted, true);
    assert.equal(img.mime, "image/jpeg");
    assert.equal(typeof img.mediaRef, "string");
    assert.equal(img.data, undefined);
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
