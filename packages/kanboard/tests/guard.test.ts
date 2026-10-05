/**
 * `src/guard.ts` on its own: shell-segment splitting, invocation parsing,
 * `isReadonly`/`isMoveBlocked`/`isRemovedEdit`, and `createWriteGuard`'s
 * budget rules — including the UNI-105 shapes (`start` on a todo OR a
 * blocked task both cost a slot the same way; `move <ID> todo` — the
 * agent's own unblock — is not the free own-claim close and still costs a
 * write even on your own claim, same as any other move).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ADD_CAP_REASON,
  CHILD_WRITE_REFUSAL,
  KNOWN_SUBCOMMANDS,
  REMOVED_REFUSAL,
  SLOTS_USED_UP,
  WRITES_USED_UP,
  addCapReason,
  createWriteGuard,
  firstPositional,
  isMoveBlocked,
  isReadonly,
  isRemovedEdit,
  kanboardInvocations,
  shellSegments,
} from "../src/guard.js";

describe("shellSegments", () => {
  it("splits on &&, ||, ;, | and newlines, ignoring separators inside quotes", () => {
    assert.deepEqual(shellSegments("a && b || c; d | e\nf"), ["a ", " b ", " c", " d ", " e", "f"]);
    const quoted = shellSegments(`note A-1 "a && b; c" && note A-2 'x | y'`);
    assert.equal(quoted.length, 2);
    assert.match(quoted[0]!, /a && b; c/);
  });

  it("keeps cut positions aligned so content before/after a separator is intact", () => {
    const segs = shellSegments("echo a; echo b");
    assert.equal(segs.join(";"), "echo a; echo b");
  });
});

describe("kanboardInvocations", () => {
  it("finds the binary as the first word of a segment, skipping VAR= and wrapper prefixes", () => {
    assert.deepEqual(kanboardInvocations("unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("FOO=1 BAR=2 unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("exec unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("command unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("env FOO=1 unipi-kanboard list"), [{ sub: "list", args: [] }]);
    assert.deepEqual(kanboardInvocations("/abs/path/unipi-kanboard.exe list"), [{ sub: "list", args: [] }]);
  });

  it("mentions of the binary that are not in command position do not count", () => {
    assert.deepEqual(kanboardInvocations("which unipi-kanboard"), []);
    assert.deepEqual(kanboardInvocations('find . -name "unipi-kanboard"'), []);
    assert.deepEqual(kanboardInvocations("ls -la"), []);
  });

  it("skips global --json / value flags before the subcommand", () => {
    assert.deepEqual(kanboardInvocations("unipi-kanboard --actor agent --project p --json list --all"), [
      { sub: "list", args: ["--all"] },
    ]);
    assert.deepEqual(kanboardInvocations("unipi-kanboard --session=s1 move A-1 done"), [
      { sub: "move", args: ["A-1", "done"] },
    ]);
  });

  it("every segment of a compound command is its own invocation", () => {
    const invocations = kanboardInvocations("unipi-kanboard start UNI-1 && unipi-kanboard finish UNI-1 --comment ok");
    assert.deepEqual(invocations.map((i) => i.sub), ["start", "finish"]);
  });
});

describe("isReadonly / isMoveBlocked / isRemovedEdit", () => {
  it("every read-only subcommand is readonly, writes are not", () => {
    for (const sub of ["list", "show", "attachments", "next", "chain", "search", "status"]) {
      const [inv] = kanboardInvocations(`unipi-kanboard ${sub}`);
      assert.ok(isReadonly(inv!), sub);
    }
    for (const cmd of ["add t", "move A-1 todo", "note A-1 x", "edit A-1 --title y", "start A-1", "finish A-1 --comment x"]) {
      assert.ok(!isReadonly(kanboardInvocations(`unipi-kanboard ${cmd}`)[0]!), cmd);
    }
  });

  it("project list/show read, archive/unarchive/rebind write", () => {
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard project list")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard project show")[0]!));
    assert.ok(!isReadonly(kanboardInvocations("unipi-kanboard project archive p")[0]!));
  });

  it("settings show/bare read, settings set writes; validate --fix writes, bare validate reads", () => {
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard settings show")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard settings")[0]!));
    assert.ok(!isReadonly(kanboardInvocations("unipi-kanboard settings set pi-command x")[0]!));
    assert.ok(isReadonly(kanboardInvocations("unipi-kanboard validate")[0]!));
    assert.ok(!isReadonly(kanboardInvocations("unipi-kanboard validate --fix")[0]!));
  });

  it("isMoveBlocked matches `move <ID> blocked` only, not blocked elsewhere or other targets", () => {
    assert.ok(isMoveBlocked(kanboardInvocations("unipi-kanboard move UNI-5 blocked --comment need creds")[0]!));
    // UNI-105: `move <ID> todo` — the agent's own unblock — is a different
    // target and is not the free own-claim close.
    assert.ok(!isMoveBlocked(kanboardInvocations("unipi-kanboard move UNI-5 todo")[0]!));
    assert.ok(!isMoveBlocked(kanboardInvocations("unipi-kanboard move UNI-5 done")[0]!));
    assert.ok(!isMoveBlocked(kanboardInvocations("unipi-kanboard list")[0]!));
  });

  it("isRemovedEdit matches --strategy/--plan on edit only", () => {
    assert.ok(isRemovedEdit(kanboardInvocations("unipi-kanboard edit A-1 --strategy swarm")[0]!));
    assert.ok(isRemovedEdit(kanboardInvocations("unipi-kanboard edit A-1 --plan=true")[0]!));
    assert.ok(!isRemovedEdit(kanboardInvocations("unipi-kanboard edit A-1 --title y")[0]!));
    assert.ok(!isRemovedEdit(kanboardInvocations("unipi-kanboard add t --label backend")[0]!));
  });

  it("firstPositional returns the first token that does not start with '-'", () => {
    const [inv] = kanboardInvocations("unipi-kanboard move UNI-5 todo --comment x");
    assert.equal(firstPositional(inv!), "UNI-5");
    const [bare] = kanboardInvocations("unipi-kanboard --json list");
    assert.equal(firstPositional(bare!), undefined, "list takes no positional");
  });
});

describe("createWriteGuard: reads, children, removed subcommands", () => {
  it("reads are always free, even with no budget open", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    assert.equal(await guard.check("unipi-kanboard list --json"), null);
    assert.equal(await guard.check("unipi-kanboard show A-1"), null);
    assert.deepEqual(guard.remaining(), { slots: 0, writes: 0, autowork: false });
  });

  it("children refuse every write, even finish and own-claim closes, even under autowork", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => true });
    assert.equal(await guard.check("unipi-kanboard list --json"), null);
    assert.equal(await guard.check("unipi-kanboard finish A-1 --comment done"), CHILD_WRITE_REFUSAL);
    assert.equal(await guard.check("unipi-kanboard note A-1 x"), CHILD_WRITE_REFUSAL);
    guard.setAutowork(true);
    assert.equal(await guard.check("unipi-kanboard add t"), CHILD_WRITE_REFUSAL);
    guard.open();
    assert.equal(await guard.check("unipi-kanboard move A-1 blocked --comment x"), CHILD_WRITE_REFUSAL);
  });

  it("removed runner subcommands and edit --strategy/--plan are refused outright, before any charge", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    for (const cmd of [
      "unipi-kanboard queue A-1",
      "unipi-kanboard unqueue A-1",
      "unipi-kanboard claim-next",
      "unipi-kanboard set-run A-1 --mode direct",
      "unipi-kanboard edit A-1 --strategy swarm",
      "unipi-kanboard edit A-1 --plan=true",
    ]) {
      assert.equal(await guard.check(cmd), REMOVED_REFUSAL, cmd);
    }
    assert.deepEqual(guard.remaining().writes, 10, "refused calls never spend budget");
  });

  it("an unknown subcommand is skipped — neither charged nor blocked", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    assert.equal(await guard.check("unipi-kanboard bogus-sub A-1"), null);
    assert.equal(await guard.check("unipi-kanboard"), null, "bare binary prints its own usage");
    assert.deepEqual(guard.remaining().writes, 10);
  });
});

describe("createWriteGuard: slots and writes", () => {
  it("start costs a slot; writes cost the write budget; both start at zero until -do opens", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 2, doWrites: () => 3, isChild: () => false });
    assert.equal(await guard.check("unipi-kanboard start UNI-1"), SLOTS_USED_UP);
    assert.equal(await guard.check("unipi-kanboard add t"), WRITES_USED_UP);
    guard.open();
    assert.deepEqual(guard.remaining(), { slots: 2, writes: 3, autowork: false });
    assert.equal(await guard.check("unipi-kanboard start UNI-1"), null);
    assert.equal(await guard.check("unipi-kanboard start UNI-2"), null);
    assert.equal(await guard.check("unipi-kanboard start UNI-3"), SLOTS_USED_UP, "cap holds across distinct tasks");
  });

  /** UNI-105: resuming a blocked task goes through the exact same `start`
   * shape the guard already charges for a fresh todo claim — the guard
   * does not (and need not) know the task's prior lane; the binary enforces
   * that distinction, the guard only meters the slot. */
  it("start costs the same slot whether it claims a fresh todo or resumes a blocked task", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 2, doWrites: () => 10, isChild: () => false });
    guard.open();
    assert.equal(await guard.check("unipi-kanboard start UNI-1"), null, "fresh claim");
    assert.equal(await guard.check("unipi-kanboard start UNI-2"), null, "resume (same shape, same cost)");
    assert.equal(await guard.check("unipi-kanboard start UNI-3"), SLOTS_USED_UP, "the cap does not distinguish the two");
  });

  it("finish is always free and never touches the write budget", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 0, isChild: () => false });
    assert.equal(await guard.check('unipi-kanboard finish A-1 --comment "done"'), null);
    assert.deepEqual(guard.remaining().writes, 0);
  });

  /** UNI-105: an agent unblocking its own claimed task — `move <ID> todo`
   * — is a distinct target from `move <ID> blocked` and is not covered by
   * the free own-claim close; it costs a write like any other move, even
   * on a task this session owns. */
  it("move <ID> todo (the agent's own unblock) still costs a write, even on an owned claim", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 3, isChild: () => false });
    guard.open();
    const deps = { ownsClaim: async () => true };
    assert.equal(await guard.check("unipi-kanboard move UNI-5 todo", deps), null);
    assert.deepEqual(guard.remaining().writes, 2, "charged despite owning the claim");
  });

  it("move <ID> blocked on an owned claim is free; on a foreign one it costs a write", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 3, isChild: () => false });
    guard.open();
    const owner = { ownsClaim: async (id: string) => id === "UNI-5" };
    assert.equal(await guard.check("unipi-kanboard move UNI-5 blocked --comment need creds", owner), null);
    assert.deepEqual(guard.remaining().writes, 3, "free: owns the claim");
    assert.equal(await guard.check("unipi-kanboard move UNI-8 blocked --comment y", owner), null);
    assert.deepEqual(guard.remaining().writes, 2, "charged: not this session's claim");
  });

  it("note/attach on an owned claim are free; a claim-ownership probe failure never grants a free write", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 3, isChild: () => false });
    guard.open();
    const broken = { ownsClaim: async () => { throw new Error("boom"); } };
    assert.equal(await guard.check("unipi-kanboard note UNI-5 x", broken), null);
    assert.deepEqual(guard.remaining().writes, 2, "a probe failure charges the write, it never grants it free");
  });

  it("autowork lifts both the slot and the write budget, but not the add cap", async () => {
    const guard = createWriteGuard({ addLimit: () => 1, doTasks: () => 0, doWrites: () => 0, isChild: () => false });
    guard.setAutowork(true);
    assert.equal(await guard.check("unipi-kanboard start UNI-1"), null);
    assert.equal(await guard.check("unipi-kanboard add first"), null);
    assert.equal(await guard.check("unipi-kanboard add second"), addCapReason(1), "the runaway guard survives autowork");
  });

  it("revoke zeroes both budgets immediately", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    assert.deepEqual(guard.remaining(), { slots: 5, writes: 10, autowork: false });
    guard.revoke();
    assert.deepEqual(guard.remaining(), { slots: 0, writes: 0, autowork: false });
    assert.equal(await guard.check("unipi-kanboard start A-1"), SLOTS_USED_UP);
  });

  it("open() tops up to at least doTasks/doWrites without stacking past them, and resets the add cap", async () => {
    const guard = createWriteGuard({ addLimit: () => 2, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    guard.open();
    assert.equal(await guard.check("unipi-kanboard add a"), null);
    assert.equal(await guard.check("unipi-kanboard add b"), null);
    assert.equal(await guard.check("unipi-kanboard add c"), addCapReason(2));
    guard.open();
    assert.equal(await guard.check("unipi-kanboard add d"), null, "a fresh window resets the cap");
  });

  it("onAgentEnd closes the -do window label but the budget persists across turns", async () => {
    const guard = createWriteGuard({ addLimit: () => 20, doTasks: () => 5, doWrites: () => 2, isChild: () => false });
    guard.open();
    guard.noteSent();
    assert.equal(guard.onAgentEnd(), false, "an end within 150ms is the previous turn's, ignored");
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(guard.onAgentEnd(), true);
    assert.equal(guard.onAgentEnd(), false, "the window label stays closed until the next open()");
    assert.equal(await guard.check("unipi-kanboard note A-1 x"), null, "budget itself outlives the turn");
    assert.equal(await guard.check("unipi-kanboard note A-2 x"), null);
    assert.equal(await guard.check("unipi-kanboard note A-3 x"), WRITES_USED_UP);
  });
});

describe("createWriteGuard: add cap", () => {
  it("the add cap counts across the whole guard lifetime per window, unlimited at 0", async () => {
    const limited = createWriteGuard({ addLimit: () => 2, doTasks: () => 5, doWrites: () => 10, isChild: () => false });
    limited.open();
    assert.equal(await limited.check("unipi-kanboard add a"), null);
    assert.equal(await limited.check("unipi-kanboard add b"), null);
    assert.equal(await limited.check("unipi-kanboard add c"), addCapReason(2));

    const unlimited = createWriteGuard({ addLimit: () => 0, doTasks: () => 5, doWrites: () => 100, isChild: () => false });
    unlimited.open();
    for (let i = 0; i < 25; i += 1) {
      assert.equal(await unlimited.check("unipi-kanboard add t"), null, `add ${i + 1}`);
    }
  });

  it("the default export constant matches addCapReason(20)", () => {
    assert.equal(ADD_CAP_REASON, addCapReason(20));
  });
});

describe("KNOWN_SUBCOMMANDS", () => {
  it("lists every clap subcommand kebab-cased, including start/finish/release used by UNI-105", () => {
    for (const sub of ["start", "finish", "release", "move", "note", "attach", "edit", "add"]) {
      assert.ok(KNOWN_SUBCOMMANDS.has(sub), sub);
    }
  });
});
