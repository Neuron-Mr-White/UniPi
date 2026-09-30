import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NudgeStash } from "../engine/nudge-stash.js";

test("put/peek/take: single slot, take clears", () => {
  const stash = new NudgeStash();
  assert.equal(stash.peek(), null);
  stash.put("first");
  assert.equal(stash.peek(), "first");
  assert.equal(stash.take(), "first");
  assert.equal(stash.peek(), null);
  assert.equal(stash.take(), null);
});

test("a new put overwrites an undelivered non-kickoff nudge", () => {
  const stash = new NudgeStash();
  stash.put("hint one");
  stash.put("hint two");
  assert.equal(stash.peek(), "hint two", "the newest intent wins");
});

test("a kickoff is never lost: new puts append until delivered", () => {
  const stash = new NudgeStash();
  stash.put("KICKOFF CONTRACT", { kickoff: true });
  stash.put("next hint");
  assert.equal(stash.peek(), "KICKOFF CONTRACT\n\nnext hint");
  stash.put("another hint");
  assert.equal(stash.peek(), "KICKOFF CONTRACT\n\nnext hint\n\nanother hint");
  assert.equal(stash.take(), "KICKOFF CONTRACT\n\nnext hint\n\nanother hint");
  // After delivery the slot is a fresh, non-kickoff slot.
  stash.put("post-kickoff");
  stash.put("newest");
  assert.equal(stash.peek(), "newest");
});

test("a kickoff put lands in an empty slot as the kickoff", () => {
  const stash = new NudgeStash();
  stash.put("hint");
  stash.take();
  stash.put("KICKOFF", { kickoff: true });
  stash.put("hint 2");
  assert.match(stash.peek() ?? "", /^KICKOFF\n\nhint 2$/);
});
