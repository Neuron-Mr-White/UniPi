import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setHerdrWorking } from "./utils.ts";

type Emitted = { name: string; payload: { active: boolean; label: string } };

function bus() {
  const events: Emitted[] = [];
  return {
    events: {
      emit: (name: string, payload: { active: boolean; label: string }) => {
        events.push({ name, payload });
      },
    },
    events_: events,
  };
}

/** Reset the module-level claim map between cases via unique keys. */
let seq = 0;
const key = () => `k${seq++}`;

describe("setHerdrWorking", () => {
  it("emits active once on first claim and inactive once on clear", () => {
    const pi = bus();
    const k = key();
    setHerdrWorking(pi, k, "waiting");
    setHerdrWorking(pi, k, "waiting"); // same label: still claimed, no emit
    setHerdrWorking(pi, k, null);
    setHerdrWorking(pi, k, null); // already cleared: no emit
    assert.deepEqual(pi.events_, [
      { name: "herdr:working", payload: { active: true, label: "waiting" } },
      { name: "herdr:working", payload: { active: false, label: "waiting" } },
    ]);
  });

  it("re-claiming with a different label swaps in one inactive + one active", () => {
    const pi = bus();
    const k = key();
    setHerdrWorking(pi, k, "a");
    setHerdrWorking(pi, k, "b");
    setHerdrWorking(pi, k, null);
    assert.deepEqual(pi.events_, [
      { name: "herdr:working", payload: { active: true, label: "a" } },
      { name: "herdr:working", payload: { active: false, label: "a" } },
      { name: "herdr:working", payload: { active: true, label: "b" } },
      { name: "herdr:working", payload: { active: false, label: "b" } },
    ]);
  });

  it("keys are independent claims", () => {
    const pi = bus();
    const a = key();
    const b = key();
    setHerdrWorking(pi, a, "bg");
    setHerdrWorking(pi, b, "sidekick");
    setHerdrWorking(pi, a, null); // b still held
    assert.equal(pi.events_.filter((e) => e.payload.active).length, 2);
    assert.equal(pi.events_.filter((e) => !e.payload.active).length, 1);
    assert.equal(pi.events_.at(-1)?.payload.label, "bg");
    setHerdrWorking(pi, b, null);
    assert.equal(pi.events_.filter((e) => !e.payload.active).length, 2);
  });

  it("never throws when the bus rejects (emitEvent swallows)", () => {
    const pi = {
      events: {
        emit: () => {
          throw new Error("bus gone");
        },
      },
    };
    const k = key();
    setHerdrWorking(pi, k, "x");
    setHerdrWorking(pi, k, null);
  });
});
