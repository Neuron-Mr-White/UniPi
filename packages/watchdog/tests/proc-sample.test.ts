import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { sampleSession } from "../src/proc-sample.js";
it("Linux real sleep and CPU session sampling", { skip: process.platform!=="linux" }, async () => {
 for(const [cmd,busy] of [["sleep 30",false],["while :; do :; done",true]] as const) {
  const child=spawn("bash",["-c",cmd],{detached:true,stdio:"ignore"});
  try { const sample=await sampleSession(child.pid!,1000);assert.ok(sample);assert.ok(busy ? sample.group_totals.cpu_pct>50 : sample.group_totals.cpu_pct<2);if(!busy)assert.ok(sample.processes.some(p=>p.comm==="sleep")); }
  finally { try{process.kill(-child.pid!,"SIGKILL");}catch{}await new Promise(resolve=>child.once("close",resolve)); }
 }
});
it("Linux node stdio socketpairs are excluded", { skip: process.platform!=="linux" }, async () => {
 const child=spawn("bash",["-c","sleep 30"],{detached:true,stdio:["ignore","pipe","pipe"]});
 try { const sample=await sampleSession(child.pid!,1000);assert.ok(sample);assert.ok(sample.processes.every(p=>p.sockets.length===0)); }
 finally { try{process.kill(-child.pid!,"SIGKILL");}catch{}await new Promise(resolve=>child.once("close",resolve)); }
});
it("Linux TCP inode joins to remote established socket", { skip: process.platform!=="linux" }, async () => {
 const sockets: import("node:net").Socket[]=[];
 const server=createServer(s=>sockets.push(s));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const port=(server.address() as import("node:net").AddressInfo).port;
 const child=spawn("python3",["-c",`import socket,time;s=socket.create_connection(('127.0.0.1',${port}));time.sleep(30)`],{detached:true,stdio:"ignore"});
 try { await new Promise(resolve=>setTimeout(resolve,100));const sample=await sampleSession(child.pid!,1000);assert.ok(sample?.processes.some(p=>p.sockets.some(s=>s.state==="ESTABLISHED" && s.remote===`127.0.0.1:${port}`))); }
 finally { try{process.kill(-child.pid!,"SIGKILL");}catch{}await new Promise(resolve=>child.once("close",resolve));for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
