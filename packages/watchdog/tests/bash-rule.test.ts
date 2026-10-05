import { it } from "node:test";
import assert from "node:assert/strict";
import { declaredBoundSec, decideBash, type BashCheckInput } from "../src/decide.js";
import { bashState } from "../src/bash-prompt.js";
const sample = { processes: [], group_totals: { cpu_pct: 0, read_bytes: 0, write_bytes: 0, rchar: 0, wchar: 0, any_running: false, io_bytes: 0 }, cumulative_io: 100 };
const base: BashCheckInput = { ageSec: 300, sinceOutputSec: 180, command: "work", sample, prevIdle: false, prevCumulativeIo: null, stop: .1, stopStreak: 0, expect: "minutes", threshold: .5, agreeChecks: 2 };
it("declared bounds", () => {
 for (const [command,bound] of [["timeout 600 ./x",600],["timeout 5m x",300],["sleep 330 && k",330],["sleep 3",null],["for i in $(seq 1 150); do x; sleep 3; done",450],["x",null]] as const) assert.equal(declaredBoundSec(command),bound);
});
it("bash trigger and veto table", () => {
 assert.equal(decideBash(base).act,false);
 assert.equal(decideBash({...base,prevIdle:true}).trigger,"idle");
 assert.equal(decideBash({...base,prevIdle:true,sample:{...sample,processes:[{ comm:"sleep",wchan:"hrtimer_nanosleep" } as never]}}).act,false);
 assert.equal(decideBash({...base,prevIdle:true,prevCumulativeIo:0,sample:{...sample,cumulative_io:5000}}).idle,false);
 const first=decideBash({...base,stop:.6});assert.equal(first.act,false);
 assert.equal(decideBash({...base,stop:.55,stopStreak:first.stopStreak}).trigger,"stop");
 assert.equal(decideBash({...base,stop:.4,stopStreak:1}).stopStreak,0);
 assert.equal(decideBash({...base,expect:"seconds"}).trigger,"expect");
 for(const overrides of [{prevIdle:true},{stop:.9,stopStreak:1},{expect:"seconds" as const}]) assert.equal(decideBash({...base,...overrides,command:"timeout 600 ./x"}).act,false);
 assert.equal(decideBash({...base,sample:null,prevIdle:true}).idle,false);
});
it("benchmark process prompt and honest second-check line", () => {
 const first=bashState("work",120,100,3,"a\roverwritten\nPrompt? ",sample);
 assert.ok(!first.includes("Output changed"));assert.match(first,/Process tree \(sampled over 5s\)/);
 const second=bashState("work",300,280,3,"a\roverwritten\nPrompt? ",sample,{age:120,changed:false});
 assert.match(second,/Output changed since previous check \(120s\): no/);
 assert.match(second,/overwritten\n\[unfinished line, no newline yet\]: "Prompt\? "/);
 assert.match(bashState("work",300,0,3,"updated",sample,{age:120,changed:true}),/Output changed since previous check \(120s\): yes/);
 console.log("MOCK STATE:\n"+second);
});
