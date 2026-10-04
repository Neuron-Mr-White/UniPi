/**
 * @unipi/core — harness message provenance lifecycle (UNI-53).
 * SDK-shaped async emitter: sendUserMessage fires the input handler
 * synchronously inside the call, then before_agent_start / message events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  harnessStateForTests,
  installHarnessProvenance,
  readHarnessMeta,
  sendHarnessUserMessage,
  userMessageText,
} from "./harness-messages.js";

type Handler = (event?: unknown, ctx?: unknown) => unknown;

function userMsg(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1234 };
}

interface HostOptions {
  /** Throw after the input stage (auth/model failure) instead of dispatching. */
  failAfterInput?: boolean;
  /** Hold dispatched messages until flush() (queued-send simulation). */
  hold?: boolean;
}

function makeHost(hostOpts: HostOptions = {}) {
  let pendingMessages: Array<ReturnType<typeof userMsg>> = [];
  const handlers: Record<string, Handler[]> = {};
  const sent: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];
  const replacements: Array<unknown> = [];
  const root = {
    isStreaming: false,
    on(name: string, fn: Handler) {
      (handlers[name] ??= []).push(fn);
      return root;
    },
    async sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }) {
      sent.push({ content, options });
      // SDK order: input handlers run to completion INSIDE sendUserMessage —
      // BEFORE model/auth validation. streamingBehavior is present only while
      // the run is active (real SDK omits it on idle events).
      for (const fn of handlers["input"] ?? []) {
        await fn({ text: content, source: "extension", streamingBehavior: this.isStreaming ? options?.deliverAs : undefined });
      }
      if (hostOpts.failAfterInput) throw new Error("no model selected");
      if (hostOpts.hold) {
        // Queued while the run is "active" — dispatched on flush().
        pendingMessages.push(userMsg(content));
        return;
      }
      await this.dispatchMessage(content);
    },
    async flush() {
      // SDK drain order: steering FIFO before follow-up FIFO.
      pendingMessages.sort((a, b) => {
        const rec = (t: string) => harnessStateForTests(root).records.find((r) => r.text === t)?.delivery === "steer" ? 0 : 1;
        return rec(a.content[0].text) - rec(b.content[0].text);
      });
      for (const message of pendingMessages) {
        for (const fn of handlers["before_agent_start"] ?? []) await fn({ prompt: message.content[0].text });
        for (const fn of handlers["message_start"] ?? []) await fn({ message });
        for (const fn of handlers["message_end"] ?? []) {
          const r = fn({ message });
          if (r && typeof r === "object" && "message" in (r as object)) replacements.push((r as { message: unknown }).message);
        }
      }
      pendingMessages = [];
    },
    async dispatchMessage(content: string) {
      for (const fn of handlers["before_agent_start"] ?? []) await fn({ prompt: content });
      const message = userMsg(content);
      for (const fn of handlers["message_start"] ?? []) await fn({ message });
      for (const fn of handlers["message_end"] ?? []) {
        const r = fn({ message });
        if (r && typeof r === "object" && "message" in (r as object)) replacements.push((r as { message: unknown }).message);
      }
    },
  };
  return {
    root: root as unknown as Parameters<typeof installHarnessProvenance>[0],
    handlers,
    sent,
    replacements,
    dispatch(name: string, event?: unknown, ctx?: unknown) {
      return (handlers[name] ?? []).map((fn) => fn(event, ctx));
    },
    flush: () => root.flush(),
  };
}

function metaOf(replacements: unknown[]): HarnessMetaLike | undefined {
  for (let i = replacements.length - 1; i >= 0; i--) {
    const meta = readHarnessMeta(replacements[i]);
    if (meta) return meta;
  }
  return undefined;
}
type HarnessMetaLike = ReturnType<typeof readHarnessMeta> & object;

test("helper preserves the raw send (content/options/await) and attaches provenance", async () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  await sendHarnessUserMessage(h.root, "check the flaky test", { source: "Progress guard", title: "No-progress guard", severity: "warning" }, { deliverAs: "steer" });
  assert.deepEqual(h.sent, [{ content: "check the flaky test", options: { deliverAs: "steer" } }]);
  const meta = metaOf(h.replacements);
  assert.ok(meta, "unipiHarness missing");
  assert.equal(meta!.source, "Progress guard");
  // Idle steer option is not effective: actual delivery is direct (raw options
  // still carried deliverAs:"steer" — asserted above).
  assert.equal(meta!.delivery, "direct");
  assert.equal(meta!.version, 1);
});

test("idle direct send is dispatch-confirmed by before_agent_start (delivery direct)", async () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  await sendHarnessUserMessage(h.root, "resume the owner", { source: "Long-horizon", title: "Resume" });
  const meta = metaOf(h.replacements);
  assert.equal(meta!.delivery, "direct");
  assert.equal(meta!.source, "Long-horizon");
});

test("no-auth failure: input DID fire, nothing dispatches, later human identical stays human", async () => {
  const h = makeHost({ failAfterInput: true });
  installHarnessProvenance(h.root);
  await assert.rejects(
    sendHarnessUserMessage(h.root, "never dispatched", { source: "Goal", title: "Never" }),
    /no model selected/,
  );
  assert.equal(h.sent.length, 1);
  // The input stage ran before the failure — the arm died with the call, and
  // the SDK emits NO agent event on auth failure. The next input purges the
  // stale direct record.
  h.dispatch("input", { text: "never dispatched", source: "interactive" });
  assert.ok(
    !harnessStateForTests(h.root).records.some((r) => r.text === "never dispatched" && r.kind === "harness"),
    "stale direct record survived the next input",
  );
  const message = userMsg("never dispatched");
  await h.dispatch("message_start", { message });
  await h.dispatch("message_end", { message });
  assert.equal(metaOf(h.replacements), undefined, "human message mislabelled after failed send");
});

test("human identical text before the harness send is never mislabelled", async () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  // Human submits first (interactive admission + dispatch).
  h.dispatch("input", { text: "same words", source: "interactive" });
  const human = userMsg("same words");
  h.dispatch("message_start", { message: human });
  h.dispatch("message_end", { message: human });
  // Harness sends the same words afterwards.
  await sendHarnessUserMessage(h.root, "same words", { source: "Goal", title: "Continuation" });
  const meta = metaOf(h.replacements);
  assert.ok(meta, "harness send lost");
  assert.equal(meta!.source, "Goal");
});

test("queued order: steer FIFO before followUp FIFO, deliveries faithful", async () => {
  const h = makeHost({ hold: true });
  installHarnessProvenance(h.root);
  h.root.isStreaming = true; // queued sends happen while the run is active
  await sendHarnessUserMessage(h.root, "follow text", { source: "Goal", title: "Follow" }, { deliverAs: "followUp" });
  await sendHarnessUserMessage(h.root, "steer text", { source: "Progress guard", title: "Guard" }, { deliverAs: "steer" });
  await h.flush();
  const firstMeta = readHarnessMeta(h.replacements[0]);
  assert.equal(firstMeta?.source, "Progress guard", "steer must drain first");
  assert.equal(metaOf(h.replacements)?.delivery, "followUp", "follow-up meta must land last");
});

test("ambiguous same text across deliveries with different origins fails closed, clears all", async () => {
  const h = makeHost({ hold: true });
  installHarnessProvenance(h.root);
  h.root.isStreaming = true; // both queued while active — realistic race
  await sendHarnessUserMessage(h.root, "dupe", { source: "Goal", title: "A" }, { deliverAs: "steer" });
  await sendHarnessUserMessage(h.root, "dupe", { source: "Ralph", title: "B" }, { deliverAs: "followUp" });
  await h.flush();
  console.log("DBG amb records:", JSON.stringify(harnessStateForTests(h.root).records), "repl:", JSON.stringify(h.replacements));
  assert.equal(metaOf(h.replacements), undefined, "conflicting group must stay native");
  assert.ok(harnessStateForTests(h.root).records.every((r) => r.state !== "admitted"), "group not cleared");
});

test("message_end without a matching message_start never re-selects", async () => {
  const h = makeHost({ hold: true });
  installHarnessProvenance(h.root);
  await sendHarnessUserMessage(h.root, "arm text", { source: "Goal", title: "T" }, { deliverAs: "steer" });
  // No message_start for this text — message_end alone must stay native and
  // must not consume the outstanding queued record.
  const message = userMsg("arm text");
  h.dispatch("message_end", { message });
  assert.equal(metaOf(h.replacements), undefined);
  assert.ok(
    harnessStateForTests(h.root).records.some((r) => r.text === "arm text" && r.state === "admitted"),
    "outstanding queued record was consumed without a selection",
  );
});

test("transformed text fails closed; a later human with the ORIGINAL text stays human", async () => {
  const h = makeHost({ hold: true });
  installHarnessProvenance(h.root);
  await sendHarnessUserMessage(h.root, "original text", { source: "Goal", title: "T" });
  // An earlier input handler transformed the text: the SDK dispatches the
  // transformed text, so the arm does not match.
  h.dispatch("input", { text: "transformed text", source: "extension" });
  const transformed = userMsg("transformed text");
  h.dispatch("message_start", { message: transformed });
  h.dispatch("message_end", { message: transformed });
  assert.equal(metaOf(h.replacements), undefined);
  h.dispatch("agent_settled");
  h.dispatch("input", { text: "original text", source: "interactive" });
  const human = userMsg("original text");
  h.dispatch("message_start", { message: human });
  h.dispatch("message_end", { message: human });
  assert.equal(metaOf(h.replacements), undefined, "human mislabelled after transform mismatch");
});

test("unattributed extension passthrough (no arm) stays unlabelled", () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  h.dispatch("input", { text: "user picked option B", source: "extension" });
  const message = userMsg("user picked option B");
  h.dispatch("message_start", { message });
  h.dispatch("message_end", { message });
  assert.equal(metaOf(h.replacements), undefined);
});

test("false marker string in human text does not label", () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  h.dispatch("input", { text: "unipiHarness is a cool field name", source: "interactive" });
  const message = userMsg("unipiHarness is a cool field name");
  h.dispatch("message_start", { message });
  h.dispatch("message_end", { message });
  assert.equal(metaOf(h.replacements), undefined);
});

test("nested proxies share one root state; install is exactly-once", async () => {
  const h = makeHost();
  const proxy1 = new Proxy(h.root, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as Parameters<typeof installHarnessProvenance>[0];
  const proxy2 = new Proxy(proxy1, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as Parameters<typeof installHarnessProvenance>[0];
  installHarnessProvenance(proxy1);
  installHarnessProvenance(proxy2);
  assert.equal((h.handlers["input"] ?? []).length, 1, "observer installed more than once");
  // Helper called through the outer proxy resolves the same root state.
  await sendHarnessUserMessage(proxy2, "proxied text", { source: "Goal", title: "P" });
  const message = userMsg("proxied text");
  h.dispatch("message_start", { message });
  h.dispatch("message_end", { message });
  assert.equal(metaOf(h.replacements)!.source, "Goal");
});

test("cancellation/settle purges outstanding; queued consumed records are pruned (bounded)", async () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  for (let i = 0; i < 200; i++) {
    const text = `task ${i}`;
    await sendHarnessUserMessage(h.root, text, { source: "Goal", title: "T" });
    h.dispatch("input", { text, source: "extension" });
    const message = userMsg(text);
    h.dispatch("message_start", { message });
    h.dispatch("message_end", { message });
  }
  assert.ok(harnessStateForTests(h.root).records.length < 10, "records leaked across a long run");
  await sendHarnessUserMessage(h.root, "aborted run", { source: "Goal", title: "T" }, { deliverAs: "steer" });
  h.dispatch("agent_settled"); // run cancelled before the message dispatched
  assert.ok(
    !harnessStateForTests(h.root).records.some((r) => r.text === "aborted run"),
    "outstanding record survived the terminal boundary",
  );
});

test("userMessageText joins text parts without separators (SDK parity)", () => {
  assert.equal(userMessageText([{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }]), "ab");
});

test("readHarnessMeta keeps valid lines, drops malformed ones without rejecting the meta", () => {
  const base = { version: 1 as const, id: "hm-x", source: "Skills", title: "Skill reveal", delivery: "direct" as const };
  const kept = readHarnessMeta({ unipiHarness: { ...base, lines: ["show-me — Helps", "kanboard — Boards"] } });
  assert.ok(kept, "meta with valid lines rejected");
  assert.deepEqual(kept!.lines, ["show-me — Helps", "kanboard — Boards"]);
  for (const bad of ["show-me, kanboard", ["ok", 42], [null], { 0: "x" }]) {
    const dropped = readHarnessMeta({ unipiHarness: { ...base, lines: bad } });
    assert.ok(dropped, `meta rejected for lines ${JSON.stringify(bad)} — must drop the field, not the meta`);
    assert.equal(dropped!.lines, undefined, `malformed lines survived: ${JSON.stringify(bad)}`);
  }
  assert.equal(readHarnessMeta({ unipiHarness: base })?.lines, undefined, "absent lines must stay absent");
});

test("earlier macrotask-deferring input handler fails closed to native (documented gap); handled input too", async () => {
  // ExtensionRunner-ish: handlers await in order inside sendUserMessage.
  const handlers: Record<string, Array<(e?: unknown) => unknown>> = {};
  const sent: string[] = [];
  const replacements: unknown[] = [];
  const root: any = {
    on(n: string, f: (e?: unknown) => unknown) { (handlers[n] ??= []).push(f); return root; },
    sendUserMessage(content: string, options?: any) {
      sent.push(content);
      return (async () => {
        for (const fn of handlers["input"] ?? []) await fn({ text: content, source: "extension", streamingBehavior: options?.deliverAs });
        const message = { role: "user", content: [{ type: "text", text: content }], timestamp: 1 };
        for (const fn of handlers["message_start"] ?? []) await fn({ message });
        for (const fn of handlers["message_end"] ?? []) {
          const r = fn({ message });
          if (r && typeof r === "object" && "message" in (r as object)) replacements.push((r as { message: unknown }).message);
        }
      })();
    },
  };
  installHarnessProvenance(root);
  // An EARLIER handler that yields (macrotask) before passing through — the
  // arm is still active because the send has not returned yet.
  handlers["input"].unshift(async (e?: any) => {
    await new Promise((r) => setTimeout(r, 5));
    return undefined; // pass through
  });
  await sendHarnessUserMessage(root, "yield case", { source: "Goal", title: "T" });
  // Documented gap: a handler that defers past the send window loses the arm —
  // fail closed to native, never a false label.
  assert.equal(readHarnessMeta(replacements.at(-1)), undefined, "deferred-handler case must stay native");

  // A HANDLED earlier input stops the chain: native fallback, and a later
  // human with the identical text stays human.
  const h2handlers: Record<string, Array<(e?: unknown) => unknown>> = {};
  const h2: any = {
    on(n: string, f: (e?: unknown) => unknown) { (h2handlers[n] ??= []).push(f); return h2; },
    sendUserMessage(content: string) {
      return (async () => {
        for (const fn of h2handlers["input"] ?? []) {
          const r = await fn({ text: content, source: "extension" });
          if (r && (r as any).action === "handled") return; // handled: no dispatch
        }
        const message = { role: "user", content: [{ type: "text", text: content }], timestamp: 1 };
        for (const fn of h2handlers["message_start"] ?? []) await fn({ message });
        for (const fn of h2handlers["message_end"] ?? []) {
          const rr = fn({ message });
          if (rr && typeof rr === "object" && "message" in (rr as object)) replacements.push((rr as { message: unknown }).message);
        }
      })();
    },
  };
  installHarnessProvenance(h2);
  h2handlers["input"].unshift(() => ({ action: "handled" }));
  await sendHarnessUserMessage(h2, "handled text", { source: "Goal", title: "T" });
  const before = replacements.length;
  h2handlers["input"].push((e?: any) => {
    h2handlers["__text"] = [e?.text];
    return undefined;
  });
  h2.sendUserMessage("handled text");
  await new Promise((r) => setTimeout(r, 5));
  const human = { role: "user", content: [{ type: "text", text: "handled text" }], timestamp: 2 };
  h2handlers["message_start"][0]?.({ message: human });
  h2handlers["message_end"][0]?.({ message: human });
  assert.equal(readHarnessMeta(replacements.at(-1)), undefined, "human mislabelled after handled input");
});

test("different human source races (interactive vs rpc vs harness) fail closed without false labels", () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  h.dispatch("input", { text: "race", source: "interactive" });
  h.dispatch("input", { text: "race", source: "rpc" });
  void sendHarnessUserMessage(h.root, "race", { source: "Goal", title: "T" });
  h.dispatch("input", { text: "race", source: "extension" });
  const message = userMsg("race");
  h.dispatch("message_start", { message });
  h.dispatch("message_end", { message });
  assert.equal(metaOf(h.replacements), undefined, "multi-source race must stay native");
  assert.ok(harnessStateForTests(h.root).records.every((r) => r.state !== "admitted"), "race group not cleared");
});

test("idle followUp helper: RAW options preserved, effective delivery direct, labeled", async () => {
  const h = makeHost();
  installHarnessProvenance(h.root);
  const origInput = h.handlers["input"]?.[0];
  if (origInput) h.handlers["input"][0] = (e?: unknown) => { console.log("DBG input ev:", JSON.stringify(e)); return (origInput as any)(e); };
  // Memory-consolidate / plan-approval pattern: followUp option while IDLE.
  await sendHarnessUserMessage(h.root, "consolidate body", { source: "Memory", title: "Consolidate session" }, { deliverAs: "followUp" });
  assert.deepEqual(h.sent, [{ content: "consolidate body", options: { deliverAs: "followUp" } }], "raw options must be passed unchanged");
  console.log("DBG records:", JSON.stringify(harnessStateForTests(h.root).records));
  const meta = metaOf(h.replacements);
  assert.ok(meta, "idle followUp must be labelled");
  assert.equal(meta!.delivery, "direct", "idle followUp option is not effective — actual delivery is direct");
  assert.equal(meta!.source, "Memory");
});

test("frozen host: repeated install stays safe, no false labels", () => {
  const handlers: Record<string, Array<(e?: unknown) => unknown>> = {};
  const sent: string[] = [];
  const replacements: unknown[] = [];
  const frozen = Object.freeze({
    on(name: string, fn: (e?: unknown) => unknown) { (handlers[name] ??= []).push(fn); return frozen; },
    sendUserMessage(content: string) {
      sent.push(content);
      return (async () => {
        for (const fn of handlers["input"] ?? []) await fn({ text: content, source: "extension" });
        const message = userMsg(content);
        for (const fn of handlers["message_start"] ?? []) await fn({ message });
        for (const fn of handlers["message_end"] ?? []) {
          const r = fn({ message });
          if (r && typeof r === "object" && "message" in (r as object)) replacements.push((r as { message: unknown }).message);
        }
      })();
    },
  }) as unknown as Parameters<typeof sendHarnessUserMessage>[0];
  // Repeated installs on the frozen host must not throw.
  installHarnessProvenance(frozen);
  installHarnessProvenance(frozen);
  // Send harness text twice through the frozen host: untracked (native).
  void sendHarnessUserMessage(frozen, "frozen harness text", { source: "Goal", title: "T" });
  const message = userMsg("frozen harness text");
  h_dispatch(handlers, "message_start", { message });
  h_dispatch(handlers, "message_end", { message });
  assert.equal(metaOf(replacements), undefined, "frozen-host harness text must stay native (documented untracked fallback)");
  // Later human identical text also native.
  handlers["input"] = [];
  h_dispatch(handlers, "input", { text: "frozen harness text", source: "interactive" });
  const human = userMsg("frozen harness text");
  h_dispatch(handlers, "message_start", { message: human });
  h_dispatch(handlers, "message_end", { message: human });
  assert.equal(metaOf(replacements), undefined, "human mislabelled on frozen host");
});

test("skill-command send matches its expanded skill block (summarize pattern)", async () => {
  const h = makeHost({ hold: true });
  installHarnessProvenance(h.root);
  await sendHarnessUserMessage(
    h.root,
    "/skill:summarize focus x",
    { source: "Utility", title: "Summarize", synopsis: "focus: focus x" },
    { expandPromptTemplates: true },
  );
  assert.deepEqual(h.sent, [{ content: "/skill:summarize focus x", options: { expandPromptTemplates: true } }], "raw send must carry the expand option unchanged");
  // pi expands /skill:<name> AFTER the input handlers: before_agent_start and
  // the message user text carry the <skill> block, not the armed text.
  const expanded =
    '<skill name="summarize" location="/s/summarize/SKILL.md">\nReferences are relative to /s/summarize.\n\nSummarize the session.\n</skill>\n\nfocus x';
  for (const fn of h.handlers["before_agent_start"] ?? []) await fn({ prompt: expanded });
  deliverExpanded(h, expanded);
  const meta = metaOf(h.replacements);
  assert.ok(meta, "expanded skill block must be labelled");
  assert.equal(meta!.source, "Utility");
  assert.equal(meta!.title, "Summarize");
});

/** message_start + message_end against the EXPANDED text, collecting the
 * message_end replacement (makeHost's flush paths only handle raw texts). */
function deliverExpanded(h: ReturnType<typeof makeHost>, expanded: string): void {
  const message = userMsg(expanded);
  h.dispatch("message_start", { message });
  for (const fn of h.handlers["message_end"] ?? []) {
    const r = fn({ message });
    if (r && typeof r === "object" && "message" in (r as object)) h.replacements.push((r as { message: unknown }).message);
  }
}

test("skill-command send with a different userMessage fails closed", async () => {
  const h = makeHost({ hold: true });
  installHarnessProvenance(h.root);
  await sendHarnessUserMessage(h.root, "/skill:summarize focus x", { source: "Utility", title: "Summarize" }, { expandPromptTemplates: true });
  const expanded =
    '<skill name="summarize" location="/s/summarize/SKILL.md">\nReferences are relative to /s/summarize.\n\nSummarize the session.\n</skill>\n\nsome other focus';
  for (const fn of h.handlers["before_agent_start"] ?? []) await fn({ prompt: expanded });
  deliverExpanded(h, expanded);
  assert.equal(metaOf(h.replacements), undefined, "mismatched skill args must stay native");
  // And exact-text matching stays as-is: an unexpanded passthrough (unknown
  // skill) still labels because the armed text equals the dispatched text.
  const h2 = makeHost({ hold: true });
  installHarnessProvenance(h2.root);
  await sendHarnessUserMessage(h2.root, "/skill:summarize focus x", { source: "Utility", title: "Summarize" }, { expandPromptTemplates: true });
  for (const fn of h2.handlers["before_agent_start"] ?? []) await fn({ prompt: "/skill:summarize focus x" });
  deliverExpanded(h2, "/skill:summarize focus x");
  assert.equal(metaOf(h2.replacements)?.source, "Utility", "exact-text passthrough must still label");
});

function h_dispatch(handlers: Record<string, Array<(e?: unknown) => unknown>>, name: string, event?: unknown): void {
  for (const fn of handlers[name] ?? []) fn(event);
}
