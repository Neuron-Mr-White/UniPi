import type { ProcSample } from "./proc-sample.js";

export const STATUS = {
  type: "choice" as const,
  instructions: "Is this long-running tool call progressing?",
  criteria: {
    progressing: "Making forward progress or doing expected long work",
    waiting: "Legitimately waiting (network, build step, sleep, human-scale timer)",
    stuck: "Hung, deadlocked, waiting on input that will never come, or frozen",
    looping: "Repeating the same failure/output without progress",
  },
};
export const STOP = {
  type: "noul" as const,
  instructions:
    "An AI coding agent ran this shell command and is blocked until it exits. Should it be stopped now " +
    "because it will not finish on its own in reasonable time (hung, deadlocked, waiting for input or a " +
    "connection that will not come, retrying forever, or a server/follow/watch that never exits)? " +
    "Answer no if it is plausibly still doing finite work that will end.",
};
export const EXPECT = {
  type: "choice" as const,
  instructions:
    "Judging from the command alone, how long should this command normally take before it exits by itself?",
  criteria: {
    seconds: "Exits within about 30 seconds (quick lookups, small scripts, status checks)",
    minutes: "A few minutes (tests, builds, installs, small migrations)",
    long: "Many minutes to hours (big builds, training, large data jobs, explicit long sleeps/timeouts)",
    never: "Never exits by design (dev server, follow/watch/tail -f, interactive session, daemon)",
  },
};
export const KIND = {
  type: "choice" as const,
  instructions: "Looking at the command and its output so far, what kind of process is this?",
  criteria: {
    finite_job: "A one-shot job that should finish and exit by itself",
    long_lived: "A service, follow/watch or daemon that never exits by design",
    needs_input: "Waiting for interactive input (a prompt, password, confirmation, editor)",
    retry_loop: "Retrying or polling the same failing thing over and over",
  },
};
const ioOf = (io: { read_bytes?: number; write_bytes?: number; rchar?: number; wchar?: number }) =>
  (io.read_bytes ?? 0) + (io.write_bytes ?? 0) + (io.rchar ?? 0) + (io.wchar ?? 0);
const fmtB = (n: number) => n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : n > 1e3 ? `${(n / 1e3).toFixed(0)}KB` : `${n}B`;
const shortFd = (t: string) => t.includes("null") ? "/dev/null" : t.startsWith("pipe") ? "pipe" : t.startsWith("socket") ? "socket" : t;

export function bashState(command: string, age: number, sinceOutput: number, bytes: number, output: string,
  sample: ProcSample | null, previous?: { age: number; changed: boolean }): string {
  let timing = `Running for: ${Math.round(age)}s\nSince last new output: ${Math.round(sinceOutput)}s\nTotal output so far: ${bytes} bytes`;
  if (previous) timing += `\nOutput changed since previous check (${Math.round(previous.age)}s): ${previous.changed ? "yes" : "no"}`;
  let processBlock = "Process tree: unavailable";
  if (sample) {
    const rows = sample.processes.slice(0, 10).map((p) => {
      const sockets = p.sockets.map((s) => `${s.state}${s.remote ? ` ${s.remote}` : ""}`).join(",");
      const wait = !p.wchan || p.wchan === "0" ? "-" : p.wchan;
      return `  ${p.comm} [${p.state}] wait=${wait} cpu=${p.cpu_pct.toFixed(0)}% io=${fmtB(ioOf(p.io))}/5s${sockets ? ` sockets=${sockets}` : ""}${p.fd0 ? ` stdin=${shortFd(p.fd0)}` : ""}${p.children ? ` children=${p.children}` : ""}`;
    });
    processBlock = `Process tree (sampled over 5s):\n${rows.join("\n") || "  (none)"}\nTotal: cpu=${sample.group_totals.cpu_pct.toFixed(0)}% io=${fmtB(ioOf(sample.group_totals))}/5s`;
  }
  const lines = output.split("\n");
  const partial = lines.pop()!.split("\r").at(-1)!;
  const tail = lines.slice(-20).map((line) => line.split("\r").at(-1)).join("\n");
  const unfinished = partial ? `\n[unfinished line, no newline yet]: ${JSON.stringify(partial)}` : "";
  return `Tool: bash\nCommand/args: ${command}\n${timing}\n${processBlock}\nLast output (tail):\n${tail || unfinished ? tail + unfinished : "(no output yet)"}`;
}
