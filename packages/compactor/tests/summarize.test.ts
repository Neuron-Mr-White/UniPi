import { describe, it, expect } from "bun:test";
import { collectSummarySource, isInjectedUserText, originKey, collectOrigins } from "../src/compaction/source.js";
import {
  buildLosslessSummary,
  selectCommits,
  selectDecisions,
  selectOpenErrors,
  selectRequests,
  selectState,
  RECALL_NOTE,
} from "../src/compaction/summarize.js";
import { assistant, compaction, custom, originMark, toolResult, user, workingSession } from "./fixtures.js";

const build = (branch: any[], budgetChars = 8000, activeWork: Array<{ id: string; text: string }> = []) =>
  buildLosslessSummary({ source: collectSummarySource(branch, branch.length), budgetChars, cwd: "/repo", activeWork });

describe("summary source", () => {
  it("drops text extensions inject with the user role", () => {
    for (const text of [
      "─────────────────────────────── 🔄 RALPH LOOP: site | Iteration 5/20",
      "No-progress guard: The same action has now run 3 times",
      "Continue working toward the active thread goal from the current conversation state.",
      "[kanboard PIT-3] Fix the header",
      "<background-task-notification> <task-id>b1</task-id> </background-task-notification>",
      "<session_resume events=\"1000\"> … </session_resume>",
    ]) {
      expect(isInjectedUserText(text)).toBe(true);
    }
    expect(isInjectedUserText("Please keep the orange theme")).toBe(false);
  });

  it("drops extension-sent user messages marked at input time", () => {
    const text = "Some brand-new extension prompt with no known shape";
    const branch = [originMark(originKey(text)), user(text), user("my real request")];
    expect(collectOrigins(branch).has(originKey(text))).toBe(true);
    expect(collectSummarySource(branch, branch.length).requests).toEqual(["my real request"]);
  });

  it("never treats custom messages as user text", () => {
    const branch = [custom("unipi-compactor-resume", "x".repeat(250_000)), user("real")];
    const source = collectSummarySource(branch, branch.length);
    expect(source.requests).toEqual(["real"]);
    expect(source.blocks.every((b) => b.kind !== "user" || b.text === "real")).toBe(true);
  });

  it("rebuilds from raw history across earlier compactions, ignoring their summaries", () => {
    const first = user("original request from before the first compaction");
    const branch = [first, assistant("working"), compaction("[User Preferences]\n- " + "BLOAT ".repeat(40_000), first.id), user("later request")];
    const summary = build(branch).text;
    expect(summary).toContain("original request from before the first compaction");
    expect(summary).toContain("later request");
    expect(summary).not.toContain("BLOAT");
  });
});

describe("lossless summary", () => {
  it("leads with active work and puts the user's words first", () => {
    const summary = build(workingSession(), 8000, [{ id: "kanboard", text: "Kanboard task PIT-3 \"Login\" is in progress" }]);
    expect(summary.text.startsWith("[Active Work]\nKanboard task PIT-3")).toBe(true);
    expect(summary.sections.slice(0, 3)).toEqual(["Active Work", "Your Requests", "Latest State"]);
    expect(summary.text).toContain("Build a login page");
    expect(summary.text).toContain("Now add a password reset link.");
    expect(summary.text.endsWith(RECALL_NOTE)).toBe(true);
    expect(summary.text).toContain("session_recall");
    expect(summary.text).not.toContain("vcc_recall");
  });

  it("uses relative paths, commit subjects and only unresolved errors", () => {
    const text = build(workingSession()).text;
    expect(text).toContain("Modified: src/Login.tsx");
    expect(text).not.toContain("/repo/src/Login.tsx,");
    expect(text).toContain("abc1234 feat: login page");
    expect(text).not.toContain("[Open Errors]"); // the failing test was re-run and passed
  });

  it("stays inside its budget however large the inputs are (bloat regression)", () => {
    const branch = [
      user("Build the site. " + "Keep it fast. ".repeat(5_000)),
      custom("unipi-compactor-resume", "<session_resume>" + "y".repeat(230_000) + "</session_resume>"),
      user("<background-task-notification> " + "z".repeat(50_000) + " </background-task-notification>"),
      assistant("r".repeat(40_000)),
      toolResult("bash", "e".repeat(100_000), true),
      ...Array.from({ length: 400 }, (_, i) => assistant(`step ${i} ` + "w".repeat(300), [{ name: "bash", arguments: { command: `echo ${i}` } }])),
    ];
    const budget = 6000;
    const summary = build(branch, budget).text;
    expect(summary.length).toBeLessThan(budget * 1.25 + RECALL_NOTE.length);
    expect(summary).not.toContain("yyyyyyyyyy");
    expect(summary).not.toContain("zzzzzzzzzz");
  });

  it("returns an empty summary for an empty branch", () => {
    expect(build([]).text).toBe("");
  });
});

describe("section selectors", () => {
  it("requests: skips trivial replies and notes what was omitted", () => {
    const lines = selectRequests(["first ask", "continue", "ok", ...Array.from({ length: 9 }, (_, i) => `ask ${i}`)], 2000);
    expect(lines[0]).toBe("first ask");
    expect(lines.some((l) => /more requests in between/.test(l))).toBe(true);
    expect(lines.at(-1)).toBe("ask 8");
    expect(lines).not.toContain("continue");
  });

  it("decisions: keeps constraints, drops questions", () => {
    const lines = selectDecisions(["Please keep the orange theme. Should we add dark mode?", "Never commit the API key."], 1000);
    expect(lines).toContain("Please keep the orange theme.");
    expect(lines).toContain("Never commit the API key.");
    expect(lines.some((l) => l.includes("dark mode"))).toBe(false);
  });

  it("state: latest step first, older full report flagged as possibly outdated", () => {
    const lines = selectState(["R".repeat(500), "short step one", "Now checking the bloom defaults."], 1200);
    expect(lines[0]).toBe("Latest step: Now checking the bloom defaults.");
    expect(lines[1]).toMatch(/^Last full report \(2 messages earlier — may be outdated\)/);
  });

  it("commits: quiet commits fall back to the -m subject", () => {
    const blocks = collectSummarySource(
      [assistant("", [{ name: "bash", arguments: { command: 'git add -A && git commit -qm "feat(webgl): field"' } }]), toolResult("bash", "")],
      2,
    ).blocks;
    expect(selectCommits(blocks, 500)).toEqual(["feat(webgl): field"]);
  });

  it("errors: an error followed by several successes of that tool counts as moved past", () => {
    const branch = [
      assistant("", [{ name: "bash", arguments: { command: "cat missing" } }]),
      toolResult("bash", "ENOENT missing", true),
      ...[1, 2, 3].flatMap((n) => [assistant("", [{ name: "bash", arguments: { command: `ls ${n}` } }]), toolResult("bash", "ok")]),
    ];
    expect(selectOpenErrors(collectSummarySource(branch, branch.length).blocks, 1000)).toEqual([]);
    const stillOpen = branch.slice(0, 2);
    expect(selectOpenErrors(collectSummarySource(stillOpen, 2).blocks, 1000)[0]).toContain("ENOENT missing");
  });
});

describe("user answers, pruning inputs and redaction", () => {
  const ask = (question: string, answer: string) => ({
    id: `ask-${question.length}`,
    type: "message",
    message: { role: "toolResult", toolName: "ask_user", toolCallId: "a", content: [{ type: "text", text: `User selected: ${answer}` }], details: { question }, isError: false },
  });

  it("an ask_user answer is the user's decision, with the answer kept whole", () => {
    const long = "Runner isn't picking up jobs even after restart. ".repeat(6) + "Which option?";
    const branch = [user("Ship the release"), ask(long, "with-windows"), ask("How should user deletion work?", "soft-delete")];
    const text = build(branch).text;
    expect(text).toContain("How should user deletion work? → soft-delete");
    expect(text).toMatch(/…\s→ with-windows/);
  });

  it("decisions: instructions, not bug reports, pastes or context-free fragments", () => {
    const lines = selectDecisions(
      [
        "Camera don't have permission, and no request for it too.",
        "Don't use emoji in the agent replies.",
        "**Deep dive**: the lead should orchestrate every stage.",
        "It is on this port instead.",
        "Use this as a prompt:\n```\nYou should always write short sentences.\n```",
      ],
      2000,
    );
    expect(lines).toEqual(["Don't use emoji in the agent replies."]);
  });

  it("redacts credentials the user typed", () => {
    const text = build([user("ssh to it, the password is '9801(*)!Pi', should be working fine though."), user("key sk-abcdefghijklmnopqrstuvwx please")]).text;
    expect(text).not.toContain("9801(*)!Pi");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(text).toContain("password is [redacted]");
    const quoted = build([user("Sudo needs a terminal → Use password '9801(*)!Pi' for it")]).text;
    expect(quoted).not.toContain("9801");
  });

});

describe("user corrections", () => {
  it("a correction of the agent's work is kept, attached to its instruction", () => {
    const lines = selectDecisions(["Also, restore the brown pink like background just now. Currently it turns to other colors already. I did not request for this change."], 1000);
    expect(lines).toEqual(["Also, restore the brown pink like background just now. I did not request for this change."]);
  });
});

describe("redaction before clipping", () => {
  it("a long answer with a quoted password is redacted even when clipped", () => {
    const q = "Tauri Linux build needs system deps (dbus, webkit2gtk, gtk3, appindicator, rsvg — the standard Tauri Linux prereqs). Sudo needs a terminal. OK?";
    const branch = [
      user("start"),
      { id: "a1", type: "message", message: { role: "toolResult", toolName: "ask_user", toolCallId: "x", content: [{ type: "text", text: "User wrote: Use password '9801(*)!Pi' for sudo" }], details: { question: q }, isError: false } },
      user("latest"),
    ];
    expect(build(branch).text).not.toContain("9801");
  });
});

describe("project knowledge", () => {
  const call = (command: string, i: number) => ({ id: `c${i}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: "bash", arguments: { command } }] } });
  it("keeps notes the agent wrote, repeated tooling commands and hosts", () => {
    const branch = [
      user("deploy it"),
      { id: "w", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tw", name: "write", arguments: { path: ".agents/skills/app-deploy/SKILL.md", content: "x" } }] } },
      call("cd app && pnpm typecheck 2>&1 | tail -5", 1),
      call("pnpm typecheck", 2),
      call("ssh -i keys/white root@1.2.3.4 'systemctl restart app'", 3),
      call("ssh -i keys/white root@1.2.3.4 'journalctl -n 5'", 4),
      call("curl -s https://app.example.com/health", 5),
      call("curl -s https://app.example.com/ready", 6),
      call("ls", 7),
      user("latest"),
    ];
    const text = build(branch).text;
    expect(text).toContain("[Project Knowledge]");
    expect(text).toContain("Notes written: .agents/skills/app-deploy/SKILL.md");
    expect(text).toContain("`pnpm typecheck` ×2");
    expect(text).toContain("`ssh -i keys/white root@1.2.3.4` ×2");
    expect(text).toContain("app.example.com");
    expect(text).not.toContain("`ls`");
  });
});
