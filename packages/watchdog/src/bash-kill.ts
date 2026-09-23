/**
 * @pi-unipi/watchdog — pid finder + process-group kill for pi's bash tool.
 *
 * pi's bash spawns the shell detached (`detached: true`), so the shell is a
 * process-group leader AND a direct child of the pi process. We never override
 * the tool: we find its child by scanning pi's direct children for the command
 * string, require an EXACT single match, and kill the whole group.
 *
 * Windows is not supported (warn only at the call site).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface KillCandidates {
  pids: number[];
  pgids: number[];
}

/** Direct children of `parentPid` whose args contain `command` (exact single match required). */
export function findBashChildren(parentPid: number, command: string): KillCandidates {
  if (process.platform === "linux") return fromLinux(parentPid, command);
  if (process.platform === "darwin") return fromPs(parentPid, command);
  return { pids: [], pgids: [] };
}

function fromLinux(parentPid: number, command: string): KillCandidates {
  const pids: number[] = [];
  const pgids: number[] = [];
  try {
    for (const entry of existsSync("/proc") ? readdirSync("/proc") : []) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === parentPid) continue;
      // /proc/<pid>/stat: field 4 = ppid, field 5 = pgrp (after the comm in parens).
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry}/stat`, "utf-8");
      } catch {
        continue; // process exited between readdir and read
      }
      const close = stat.lastIndexOf(")");
      if (close === -1) continue;
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      if (ppid !== parentPid) continue;
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8").replace(/\0/g, " ");
      } catch {
        continue;
      }
      if (!cmdline.includes(command)) continue;
      const pgid = Number(fields[2]);
      pids.push(pid);
      pgids.push(pgid);
    }
  } catch {
    // /proc unavailable — treat as no candidates (downgrade to warn).
  }
  return { pids, pgids };
}

function fromPs(parentPid: number, command: string): KillCandidates {
  try {
    const out = execFileSync("ps", ["-o", "pid=,ppid=,pgid=,args=", "-A"], { encoding: "utf-8" });
    const pids: number[] = [];
    const pgids: number[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      const pgid = Number(parts[2]);
      const args = parts.slice(3).join(" ");
      if (ppid === parentPid && args.includes(command)) {
        pids.push(pid);
        pgids.push(pgid);
      }
    }
    return { pids, pgids };
  } catch {
    return { pids: [], pgids: [] };
  }
}

export interface GroupKillOutcome {
  killed: boolean;
  candidates: number;
}

/**
 * Kill the process group of a single matched child. SIGTERM first, SIGKILL
 * after 3s if the group leader is still alive. `exactCandidates` guards the
 * ambiguity rule — the caller passes the candidate count.
 */
export function killProcessGroup(pgid: number, pid: number, exactCandidates: number): GroupKillOutcome {
  if (exactCandidates !== 1) return { killed: false, candidates: exactCandidates };
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return { killed: false, candidates: exactCandidates };
  }
  // SIGKILL escalation after 3s if the leader is still alive.
  const escalation = setTimeout(() => {
    try {
      process.kill(pid, 0); // still alive?
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone
      }
    } catch {
      // exited before escalation
    }
  }, 3000);
  escalation.unref?.();
  return { killed: true, candidates: 1 };
}
