import { childContactSupervisor } from "./src/supervisor-channel.js";
const result = childContactSupervisor({ reason: "need_decision", message: "which approach?", timeoutMs: 20000 }, {
  channelDir: "/tmp/unipi-supervisor-wOres7/run-1-worker",
  runId: "run-1",
  agent: "worker",
  parentSessionId: "parent-1",
});
console.log(JSON.stringify(result));