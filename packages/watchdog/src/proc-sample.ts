import { readdir, readFile, readlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
export interface Io { read_bytes: number; write_bytes: number; rchar: number; wchar: number }
export interface ProcRow { pid: number; ppid: number; comm: string; cmdline: string; state: string; wchan: string; fd0: string | null; cpu_pct: number; io: Io; sockets: Array<{ fd: number; inode: string; state: string; remote: string | null }>; children: number }
export interface ProcSample { processes: ProcRow[]; group_totals: Io & { cpu_pct: number; any_running: boolean; io_bytes: number }; cumulative_io: number }
type Raw = Omit<ProcRow,"cpu_pct"|"children"|"sockets"> & { ticks: number; start: number; inodes: Array<[number,string]> };
let hz: number | undefined;
const zero = (): Io => ({ read_bytes: 0, write_bytes: 0, rchar: 0, wchar: 0 });
async function members(sid: number): Promise<Map<number,Raw>> {
  const result = new Map<number,Raw>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const base = `/proc/${name}`;
    try {
      const raw = await readFile(`${base}/stat`,"utf8"), end = raw.lastIndexOf(")"), f = raw.slice(end+2).split(" ");
      if (+f[3]! !== sid) continue;
      const io = zero();
      try { for (const line of (await readFile(`${base}/io`,"utf8")).split("\n")) { const [k,v] = line.split(":"); if (k && k in io) io[k as keyof Io] = Number(v); } } catch {}
      let fd0: string | null = null; try { fd0 = await readlink(`${base}/fd/0`); } catch {}
      const inodes: Array<[number,string]> = [];
      try { for (const fd of await readdir(`${base}/fd`)) { try { const target = await readlink(`${base}/fd/${fd}`); const match = /^socket:\[(\d+)\]$/.exec(target); if (match) inodes.push([+fd,match[1]!]); } catch {} } } catch {}
      result.set(+name,{ pid:+name,ppid:+f[1]!,comm:raw.slice(raw.indexOf("(")+1,end),cmdline:(await readFile(`${base}/cmdline`)).toString().replaceAll("\0"," ").trim().slice(0,160),state:f[0]!,wchan:(await readFile(`${base}/wchan`,"utf8")).trim(),fd0,io,ticks:+f[11]! + +f[12]!,start:+f[19]!,inodes });
    } catch {}
  }
  return result;
}
const states: Record<string,string> = { "01":"ESTABLISHED","02":"SYN_SENT","03":"SYN_RECV","04":"FIN_WAIT1","05":"FIN_WAIT2","06":"TIME_WAIT","07":"CLOSE","08":"CLOSE_WAIT","09":"LAST_ACK","0A":"LISTEN","0B":"CLOSING","0C":"NEW_SYN_RECV" };
function address(value: string, ipv6: boolean): string {
  const [hex,port] = value.split(":"), bytes = Buffer.from(hex!,"hex");
  for (let i=0;i<bytes.length;i+=4) bytes.subarray(i,i+4).reverse();
  const ip = ipv6 ? Array.from({length:8},(_,i)=>bytes.readUInt16BE(i*2).toString(16)).join(":") : [...bytes].join(".");
  return `${ipv6 ? `[${ip}]` : ip}:${parseInt(port!,16)}`;
}
async function socketTable(): Promise<Map<string,{state:string;remote:string}>> {
  const result = new Map<string,{state:string;remote:string}>();
  for (const name of ["tcp","tcp6"]) for (const line of (await readFile(`/proc/net/${name}`,"utf8")).split("\n").slice(1).filter(Boolean)) {
    const f=line.trim().split(/\s+/);result.set(f[9]!,{state:states[f[3]!] ?? f[3]!,remote:address(f[2]!,name==="tcp6")});
  }
  return result;
}
export async function sampleSession(sid: number, windowMs=5000): Promise<ProcSample|null> {
  if (process.platform!=="linux") return null;
  try {
    if (hz===undefined) { try { hz=Number(execFileSync("getconf",["CLK_TCK"],{encoding:"utf8",timeout:1000}).trim()) || 100; } catch { hz=100; } }
    const start=performance.now(),before=await members(sid);
    await new Promise(resolve=>setTimeout(resolve,windowMs));
    const after=await members(sid),seconds=(performance.now()-start)/1000,table=await socketTable();
    if (!after.size) return null;
    const totals={...zero(),cpu_pct:0,any_running:false,io_bytes:0};let cumulative_io=0;
    const processes: ProcRow[]=[];
    for (const raw of after.values()) {
      const old=before.get(raw.pid),valid=old?.start===raw.start,io=zero();
      for (const key of Object.keys(io) as Array<keyof Io>) { io[key]=valid ? Math.max(0,raw.io[key]-old!.io[key]) : 0;totals[key]+=io[key]; }
      const cpu=valid ? Math.max(0,raw.ticks-old!.ticks)/hz/seconds*100 : 0;
      totals.cpu_pct+=cpu;totals.any_running ||= raw.state==="R";cumulative_io+=raw.io.rchar+raw.io.wchar;
      const {ticks,start,inodes,...row}=raw;
      processes.push({...row,io,cpu_pct:cpu,sockets:inodes.filter(([,inode])=>table.has(inode)).map(([fd,inode])=>({fd,inode,...table.get(inode)!})),children:[...after.values()].filter(p=>p.ppid===raw.pid).length});
    }
    totals.io_bytes=totals.read_bytes+totals.write_bytes;
    return {processes,group_totals:totals,cumulative_io};
  } catch { return null; }
}
