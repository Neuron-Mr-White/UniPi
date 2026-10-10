/**
 * @pi-unipi/dream — background dreaming for pi.
 *
 * OFF by default (settings `dream.enabled`, /unipi:settings → Dream). When
 * on, every pi open (session_start, once per process) checks whether enough
 * new struggle sessions have piled up since the last dream and, if so,
 * spawns a detached `pi -p` child that reviews session digests, applies
 * memory lessons (through the memory extension's tools, so the palace index
 * stays in sync), and leaves skill/check proposals in a staging directory.
 * While off nothing runs on open: no digest work, no child.
 *
 * `/unipi:dream run`, the work tray's Dream tab (`r`) and the app's Dream
 * sheet ("Run now") start one by hand either way. The next open shows the
 * report; approve/reject proposals from the tray, the app, or
 * `/unipi:dream approve|reject <n>` (skills must pass craft-skill's check).
 *
 * Every hook body is guarded: this extension must never abort a turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getSettings, isChildProcess, openWorkTray, registerWorkTrayTab } from "@pi-unipi/core";
import "../src/settings.ts";
import { normalizeDream } from "../src/settings.ts";
import { countNewSessions, sessionDirFor } from "../src/digest.ts";
import { isDue, readDreamState, writeDreamState, dreamStatePath } from "../src/schedule.ts";
import { startDream } from "../src/runner.ts";
import { listProposals, listStagingDirs } from "../src/report.ts";
import { DreamController, memoryRootFor, publishDreamApi } from "../src/controller.ts";
import { DreamPane } from "../src/tray-pane.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export { memoryRootFor };

const REPORT_CARD = "unipi-dream-report-card";

let checkedThisProcess = false;

/** Test hook: let the next session_start run the open-time check again. */
export function resetDreamForTests(): void {
  checkedThisProcess = false;
}

/** Status text for `/unipi:dream` / `status` (pure over the controller). */
export function statusText(ctl: DreamController, statePath: string): string {
  const s = ctl.status();
  const runs = ctl.runs();
  const latest = runs.find((r) => r.hasReport);
  const lines = [
    s.enabled
      ? `dream: on · ${s.due ? (s.due.due ? "due at the next pi open" : `not due: ${s.due.reason}`) : "schedule unknown"}`
      : "dream: off — turn on in /unipi:settings → Dream (manual /unipi:dream run still works)",
    `last run ${s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never"}${s.running ? " · a dream is running now" : ""}`,
    `state: ${statePath}`,
    latest ? `latest report: ${path.join(latest.staging, "DREAM_REPORT.md")}` : "no report yet",
    ...(latest?.proposals ?? []).map((p, i) => `  ${String(i + 1)}. [${p.kind}] ${p.name} — ${p.decision}`),
    latest?.proposals.some((p) => p.decision === "pending") ? "approve with /unipi:dream approve <n> (or the work tray's Dream tab)" : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export default function (pi: ExtensionAPI): void {
  // A dream child (or any unipi child process) never dreams itself.
  const child = isChildProcess() || Boolean(process.env.PI_DREAM_STAGING);

  let cwd = process.cwd();
  const ctl = new DreamController({ cwd: () => cwd });
  if (!child) publishDreamApi(ctl);

  const runGuarded = (fn: () => void | Promise<void>): void => {
    void (async () => {
      try {
        await fn();
      } catch {
        // never abort a turn
      }
    })();
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      cwd = ctx.cwd ?? process.cwd();
      ctl.invalidate();
    } catch {
      /* keep the old cwd */
    }
    if (child || checkedThisProcess) return;
    checkedThisProcess = true;
    runGuarded(() => {
      const cfg = normalizeDream(getSettings("dream", cwd));
      const state = readDreamState(cwd);

      // Surface a finished, unshown report (also from a manual run while off).
      const reportDir = listStagingDirs(cwd)[0];
      if (reportDir && state.shownReport !== reportDir && !(state.dismissed ?? []).includes(path.basename(reportDir))) {
        const pending = listProposals(reportDir, state.decisions).filter((p) => p.decision === "pending");
        try {
          pi.appendEntry(REPORT_CARD, { report: path.join(reportDir, "DREAM_REPORT.md"), pending: pending.length });
        } catch {
          // UI-dependent
        }
        writeDreamState(cwd, { ...state, shownReport: reportDir });
        return; // don't start a new dream the same moment a report lands
      }

      // Off: nothing else runs on open — no session scan, no digest, no child.
      if (!cfg.enabled) return;

      const newSessions = countNewSessions(sessionDirFor(cwd), state.lastRunAt);
      const due = isDue(state, newSessions, cfg);
      if (!due.due) return;
      const launch = startDream(cwd, cfg, memoryRootFor(cwd), {
        manual: false,
        onExit: () => {
          ctl.invalidate();
          ctl.emit();
        },
      });
      if (!launch) return;
      writeDreamState(cwd, {
        ...state,
        lastRunAt: Date.now(),
        sessionsSeen: due.newSessions,
        lock: { pid: launch.pid, at: Date.now() },
        shownReport: null,
      });
      ctl.invalidate();
      ctl.emit();
    });
  });

  pi.on("session_shutdown", () => {
    try {
      ctl.dispose();
    } catch {
      /* ignore */
    }
  });

  // The work tray's Dream tab: only shown when there is a dream run/history
  // or dreaming is on. A dream never wakes the agent, so it is not a wait
  // source (no "Working…" line).
  if (!child) {
    try {
      registerWorkTrayTab(pi, {
        id: "dream",
        label: "Dream",
        order: 2,
        visible: () => {
          try {
            return ctl.runs().length > 0 || ctl.settings().enabled;
          } catch {
            return false;
          }
        },
        counts: () => {
          const runs = ctl.runs();
          return { total: runs.length, running: runs.filter((r) => r.status === "running").length };
        },
        createPane: ({ tui, theme, close, initialId }) => {
          const pane = new DreamPane(
            tui,
            theme,
            {
              runs: () => ctl.runs(),
              detail: (id) => ctl.detail(id),
              enabled: () => ctl.settings().enabled,
              run: () => ctl.run({ manual: true }),
              stop: (id) => ctl.stop(id),
              approve: (r, p) => ctl.approve(r, p),
              reject: (r, p) => ctl.reject(r, p),
              dismiss: (r) => ctl.dismiss(r),
            },
            close,
            initialId,
          );
          const unsub = ctl.subscribe(() => tui.requestRender());
          const dispose = pane.dispose.bind(pane);
          pane.dispose = () => {
            unsub();
            dispose();
          };
          return pane;
        },
      });
    } catch {
      // the tray is optional UI
    }
  }

  try {
    pi.registerEntryRenderer?.<{ report: string; pending: number }>(REPORT_CARD, (entry, _options, theme) => {
      const d = entry.data;
      if (!d || !theme) return undefined;
      const t = theme as { bold(s: string): string; fg(c: string, s: string): string };
      // A real Component (pi calls .render(width)); a plain {lines} object
      // crashed the TUI on session load ("child.render is not a function").
      return new Text(
        [
          `${t.bold("▌ Dream report ready")} ${t.fg("dim", `${d.pending} proposal${d.pending === 1 ? "" : "s"} waiting`)}`,
          t.fg("dim", `/unipi:dream tray · /unipi:dream report · /unipi:dream approve <n>`),
        ].join("\n"),
        0,
        0,
      );
    });
  } catch {
    // UI-dependent
  }

  const openTray = async (ctx: ExtensionContext, initialId?: string): Promise<boolean> => {
    if (!ctx.hasUI) return false;
    await openWorkTray(ctx, { tab: "dream", ...(initialId !== undefined ? { initialId } : {}) });
    return true;
  };

  pi.registerCommand("unipi:dream", {
    description: "Dream (background memory consolidation): /unipi:dream status|tray|report|run|stop|approve <n>|reject <n>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      cwd = ctx.cwd ?? cwd;
      ctl.invalidate();

      const say = (text: string, level: "info" | "warning" | "error" = "info"): void => {
        try {
          ctx.ui.notify(text, level);
        } catch {
          // no UI (headless)
        }
      };

      if (sub === "status") return say(statusText(ctl, dreamStatePath(cwd)));

      if (sub === "tray" || sub === "open") {
        if (!(await openTray(ctx))) say(statusText(ctl, dreamStatePath(cwd)));
        return;
      }

      if (sub === "report") {
        const latest = ctl.runs().find((r) => r.hasReport);
        if (!latest) return say("no dream report yet");
        try {
          say(fs.readFileSync(path.join(latest.staging, "DREAM_REPORT.md"), "utf8"));
        } catch {
          say("report unreadable", "error");
        }
        return;
      }

      if (sub === "approve" || sub === "reject") {
        const latest = ctl.runs().find((r) => r.hasReport);
        if (!latest) return say("no proposals yet");
        const n = Number(parts[1]);
        const proposal = latest.proposals[Number.isInteger(n) && n >= 1 ? n - 1 : -1];
        if (!proposal) return say(`usage: /unipi:dream ${sub} <1-${String(latest.proposals.length)}>`, "warning");
        const r = sub === "approve" ? ctl.approve(latest.id, proposal.id) : ctl.reject(latest.id, proposal.id);
        return say(r.message, r.ok ? "info" : "error");
      }

      if (sub === "run") {
        const r = ctl.run({ manual: true });
        if (!r.ok) return say(r.message, "warning");
        say(`${r.message}${r.launch ? `\nlog: ${r.launch.logFile}` : ""}\nWatch it in the work tray (↓ → Dream).`);
        return;
      }

      if (sub === "stop") {
        const r = ctl.stop();
        return say(r.message, r.ok ? "info" : "warning");
      }

      say("usage: /unipi:dream status|tray|report|run|stop|approve <n>|reject <n>", "warning");
    },
  });
}
