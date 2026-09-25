/**
 * @unipi/memory — Extension entry
 *
 * Markdown files are the durable tier; MemPalace (daemon-driven writes,
 * warm read-only MCP reader) is the searchable palace. Other agents'
 * drawers are first-class citizens — pi sees and remembers them.
 */

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  UNIPI_EVENTS,
  MODULES,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";

import { createSessionBackend, type SessionBackend } from "./session.js";
import { registerMemoryTools, MEMORY_TOOLS, memoryCard } from "./tools.js";
import { registerMemoryCommands, type SessionOverrides } from "./commands.js";
import { readMemoryConfig, agentHooksEnabled } from "./settings.js";
import { replayPending, pendingCount, type PendingOp } from "./pending.js";
import { adoptLooseFiles, needsMigration, runConversion, readConversionState } from "./convert.js";
import {
  maybeAutoUpdateMempalace,
  DEFAULT_PALACE,
  detectVersion,
  findVenvPython,
  runProcess,
  writeCachedInstall,
} from "./mempalace.js";
import { fileThroughDaemon, deleteViaWriteMcp, deleteThroughDaemon, mineDirect } from "./daemon.js";
import { projectName, projectDir, memoryRoot } from "./paths.js";

function getInfoRegistry() {
  return (globalThis as { __unipi_info_registry?: any }).__unipi_info_registry;
}

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

const RECALL_CUSTOM_TYPE = "unipi-memory-recall-reminder";
const RETRO_CUSTOM_TYPE = "unipi-memory-retro-reminder";
const CARD_CUSTOM_TYPE = "unipi-memory-session-card";

export function buildMemoryRecallReminder(input: {
  projectName: string;
  memories: Array<{ title: string }>;
  canSearch: boolean;
  canStore: boolean;
  wakeUp?: string;
}): string {
  const lines = [
    "## 🧠 Memory System Active",
    "",
    `You have ${input.memories.length} memories stored for project "${input.projectName}".`,
  ];
  if (input.canSearch && input.memories.length > 0) {
    const titleList = input.memories.slice(0, 20).map((m) => `- ${m.title}`).join("\n");
    const extra = input.memories.length > 20 ? `\n... and ${input.memories.length - 20} more` : "";
    lines.push(
      "**BEFORE starting work**, call `memory_search` with relevant keywords to check for existing context.",
      "",
      "Available memories:",
      titleList + extra,
    );
  }
  if (input.canStore) {
    lines.push(
      "",
      "**AFTER completing the task**, if you learned something non-obvious,",
      "call `memory_store` to save it for future sessions.",
    );
  }
  lines.push(
    "",
    "Guardrails: read max 10 memory results per search. Update existing memories instead of creating duplicates.",
  );
  if (input.wakeUp) {
    lines.push("", "---", "", input.wakeUp);
  }
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  let backend: SessionBackend | null = null;
  let recallDone = false;
  let storeDone = false;
  const overrides: SessionOverrides = {};
  let cardEntry: { project: string; count: number } | null = null;
  let wakeUpPromise: Promise<string | null> | null = null;
  let pendingTimer: NodeJS.Timeout | null = null;
  let replaying = false;
  let replayKick: () => void = () => {};
  let totalMemories = { value: 0, at: 0 };
  const countAllMemories = (): number => {
    // Walk the memory root counting *.md — cheap enough to cache for ~60s.
    if (Date.now() - totalMemories.at < 60_000) return totalMemories.value;
    let n = 0;
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) n += 1;
      }
    };
    try { walk(memoryRoot()); } catch { /* keep last */ }
    totalMemories = { value: n, at: Date.now() };
    return n;
  };

  registerMemoryTools(pi, () => backend, {
    onRecall: () => { recallDone = true; },
    onStore: () => { storeDone = true; },
    onWriteDone: () => replayKick(),
  }, { neutral: !readMemoryConfig().recallAtStart });
  registerMemoryCommands(pi, () => backend, overrides);

  // Render the recall/end reminders as small badges (UI-only).
  try {
    const badge = (icon: string, label: string) =>
      (message: { content?: unknown }, _options: unknown, theme: { bg?: (c: string, t: string) => string; fg?: (c: string, t: string) => string; bold?: (t: string) => string }) => {
        const text = String(message.content ?? "").split("\n")[0] ?? label;
        const inner = theme.fg?.("syntaxKeyword", theme.bold?.(` ${icon} ${label} `) ?? ` ${icon} ${label} `) ?? ` ${label} `;
        const b = theme.bg?.("customMessageBg", inner) ?? inner;
        return new Text(`${b} ${theme.fg?.("dim", text.replace(/[*#🧠]/gu, "").trim()) ?? text}`, 0, 0);
      };
    pi.registerMessageRenderer?.(RECALL_CUSTOM_TYPE, badge("◈", "memory recall") as never);
    pi.registerMessageRenderer?.(RETRO_CUSTOM_TYPE, badge("◈", "memory save?") as never);
  } catch { /* renderer registration is UI-dependent */ }

  // Session card (UI-only entry + renderer).
  try {
    pi.registerEntryRenderer?.<{ project: string; count: number; wakeUp?: string; issue?: string; needsMigrate?: boolean }>(
      CARD_CUSTOM_TYPE,
      (entry, _options, theme) => {
        const d = entry.data;
        if (!d) return undefined;
        const cfg = readMemoryConfig();
        const recall = cfg.recallAtStart && overrides.recall !== false ? "on" : "off";
        const write = cfg.write && overrides.write !== false ? "on" : "off";
        const lines = [
          `◈ memory palace · ${d.project}`,
          `${d.count} memories · recall ${recall} · write ${write}${d.wakeUp ? " · wake-up ready (expand)" : ""}`,
          ...(d.issue ? [d.issue] : []),
          ...(d.needsMigrate ? ["v2 memories found — run /unipi:memory migrate"] : []),
        ];
        if ((_options as { expanded?: boolean } | undefined)?.expanded && d.wakeUp) {
          lines.push("", ...d.wakeUp.split("\n"));
        }
        return memoryCard(theme as never, lines);
      },
    );
  } catch { /* UI-dependent */ }

  pi.on("session_start", async (_event, ctx) => {
    recallDone = false;
    storeDone = false;
    overrides.recall = undefined;
    overrides.write = undefined;
    wakeUpPromise = null;

    const cfg = readMemoryConfig(ctx.cwd);
    if (cfg.write === false) {
      const active = pi.getActiveTools().filter(
        (t) => t !== MEMORY_TOOLS.STORE && t !== MEMORY_TOOLS.DELETE,
      );
      pi.setActiveTools(active);
    }

    backend = createSessionBackend(ctx.cwd);
    const b = backend;
    const migrating = needsMigration();

    // Version gate: createSessionBackend already re-detected a stale version.
    // Still <MIN → one background `uv tool upgrade` attempt; the new version
    // applies next session (the cache is refreshed after the upgrade).
    if (b.install && b.mode === "local") {
      void (async () => {
        const ok = await runProcess("uv", ["tool", "upgrade", "mempalace"], 300_000);
        if (!ok) return;
        const python = findVenvPython();
        if (python) writeCachedInstall({ python, version: detectVersion(python) });
      })();
    }

    // Wake-up runs once in the background; consumers race it with a 1s cap.
    wakeUpPromise =
      cfg.recallAtStart && cfg.wakeUp && b.mode === "palace" && b.install
        ? b.wakeUpText().then((t) => t?.slice(0, 3500) ?? null).catch(() => null)
        : null;

    /** Replay journaled writes via the same store/delete path. */
    const filePending = async (op: PendingOp) => {
      if (!b.install || b.mode === "local") return "markdown-only" as const;
      if (op.kind === "store") {
        const res = await fileThroughDaemon(
          b.install, projectDir(op.project), [op.file], op.project, DEFAULT_PALACE, 30_000,
        );
        if (res.outcome === "filed" || res.outcome === "queued") return res.outcome;
        const direct = await mineDirect(b.install, projectDir(op.project), op.project, DEFAULT_PALACE);
        return direct.ok ? ("filed" as const) : ("markdown-only" as const);
      }
      const res = await deleteThroughDaemon(b.install, op.file, DEFAULT_PALACE, 30_000);
      if (res.outcome === "filed" || res.outcome === "queued") return res.outcome;
      const direct = await deleteViaWriteMcp(b.install, op.file, DEFAULT_PALACE);
      return direct.ok ? ("filed" as const) : ("markdown-only" as const);
    };
    const maybeReplay = async () => {
      if (replaying || pendingCount() === 0) return;
      replaying = true;
      try {
        await replayPending(filePending);
      } catch { /* stay journaled */ } finally {
        replaying = false;
      }
    };
    replayKick = () => { void maybeReplay(); };
    // Every 2 min while ops are pending (unref'd, cleared on shutdown).
    if (pendingTimer) clearInterval(pendingTimer);
    pendingTimer = setInterval(() => {
      if (pendingCount() === 0) { if (pendingTimer) clearInterval(pendingTimer); pendingTimer = null; return; }
      void maybeReplay();
    }, 120_000);
    pendingTimer.unref?.();

    if (migrating && ctx.hasUI) {
      ctx.ui.notify("v2 memories found — run /unipi:memory migrate to convert them (backups included).", "info");
    }

    // ── background upkeep ──────────────────────────────────────────────
    void (async () => {
      await maybeReplay(); // journal replay at session start

      // An in-progress conversion resumes in the background — the user opted
      // in when they ran `/unipi:memory migrate`. Pending/failed stays put.
      const prior = readConversionState();
      const inProgress = prior && prior.phase !== "pending" && prior.phase !== "done" && prior.phase !== "failed";
      if (inProgress && b.install && b.reader) {
        let cur = prior;
        for (let i = 0; i < 100 && cur.phase !== "done" && cur.phase !== "failed"; i++) {
          cur = await runConversion({ install: b.install, reader: b.reader }).catch(() => cur);
          if (cur.phase === "done" || cur.phase === "failed") break;
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }

      // Loose-file adoption: v2 installs still writing flat files land in the
      // typed layout + get filed (post-conversion only).
      if (readConversionState()?.phase === "done" && b.install && b.mode === "palace") {
        for (const adopted of adoptLooseFiles()) {
          const res = await fileThroughDaemon(
            b.install, projectDir(adopted.project), [adopted.filePath], adopted.project, DEFAULT_PALACE, 30_000,
          );
          if (res.outcome !== "filed" && res.outcome !== "queued") {
            const direct = await mineDirect(b.install, projectDir(adopted.project), adopted.project, DEFAULT_PALACE);
            if (!direct.ok) {
              // Journal the adopted file just like a user store.
              const { enqueuePending } = await import("./pending.js");
              enqueuePending({
                kind: "store", file: adopted.filePath, project: adopted.project,
                id: adopted.rec.id, enqueuedAt: new Date().toISOString(), heldBy: direct.heldBy,
              });
            }
          }
          // Orphaned drawers for the old flat path (idempotent — 0 deleted ok).
          for (const src of [adopted.oldPath, adopted.origPath].filter((x): x is string => !!x)) {
            const del = await deleteThroughDaemon(b.install, src, DEFAULT_PALACE, 30_000);
            if (del.outcome !== "filed" && del.outcome !== "queued") {
              await deleteViaWriteMcp(b.install, src, DEFAULT_PALACE).catch(() => ({ ok: false }));
            }
          }
        }
      }

      // Auto-update the MemPalace install (~daily PyPI check, uv upgrade).
      if (b.install && cfg.mempalaceAutoUpdate) {
        void maybeAutoUpdateMempalace()
          .then((outcome) => {
            if (outcome.updated) {
              emitEvent(pi, UNIPI_EVENTS.UPDATE_APPLIED, {
                previousVersion: outcome.currentVersion ?? "",
                newVersion: outcome.latestVersion ?? "",
              });
            }
          })
          .catch(() => {});
      }
    })();

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.MEMORY,
      version: VERSION,
      commands: [
        "unipi:memory", "unipi:memory-process", "unipi:memory-consolidate",
        "unipi:memory-search", "unipi:global-memory-search",
        "unipi:memory-forget", "unipi:global-memory-list",
      ],
      tools: [
        MEMORY_TOOLS.STORE,
        MEMORY_TOOLS.SEARCH,
        MEMORY_TOOLS.DELETE,
        MEMORY_TOOLS.LIST,
      ],
    });

    const registry = getInfoRegistry();
    if (registry) {
      registry.registerGroup({
        id: "memory",
        name: "Memory",
        icon: "🧠",
        priority: 60,
        config: {
          showByDefault: true,
          stats: [
            { id: "projectCount", label: "Project Memories", show: true },
            { id: "totalCount", label: "Total Memories", show: true },
            { id: "recall", label: "Recall", show: true },
            { id: "write", label: "Write", show: true },
            { id: "pending", label: "Pending Ops", show: true },
            { id: "migrate", label: "Migration", show: true },
          ],
        },
        dataProvider: async () => {
          const counts = b ? await b.list().catch(() => []) : [];
          const conv = readConversionState();
          return {
            projectCount: { value: String(counts.length) },
            totalCount: { value: String(countAllMemories()) },
            recall: { value: cfg.recallAtStart && overrides.recall !== false ? "on" : "off" },
            write: { value: cfg.write && overrides.write !== false ? "on" : "off" },
            pending: { value: String(pendingCount()) },
            migrate: {
              value: conv && conv.phase !== "done"
                ? `${conv.phase} ${conv.done}/${conv.total}`
                : needsMigration() ? "needed" : "—",
            },
          };
        },
      });
    }

    // Session card + footer status once counts land.
    if (ctx.hasUI) {
      const setStatus = (s: string) => ctx.ui.setStatus("unipi-memory", s);
      setStatus("🧠 …");
      void (async () => {
        const counts = (await b.list().catch(() => [])) ?? [];
        const pend = pendingCount();
        setStatus(
          migrating
            ? "🧠 migrate: /unipi:memory migrate"
            : `🧠 ${counts.length} mem${pend > 0 ? ` +${pend}⧗` : ""}`,
        );
        if (!cardEntry) {
          cardEntry = { project: b.project, count: counts.length };
          const wake = wakeUpPromise ? (await wakeUpPromise) ?? undefined : undefined;
          pi.appendEntry(CARD_CUSTOM_TYPE, {
            project: b.project,
            count: counts.length,
            wakeUp: wake,
            issue: b.installIssue,
            needsMigrate: migrating,
          });
        }
      })();
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (recallDone) return;
    if (!backend) return;
    const cfg = readMemoryConfig(ctx.cwd);
    if (!cfg.recallAtStart || overrides.recall === false) {
      recallDone = true;
      return;
    }
    if (!agentHooksEnabled()) {
      recallDone = true;
      return;
    }

    const activeTools = new Set(pi.getActiveTools());
    const canSearch = activeTools.has(MEMORY_TOOLS.SEARCH) || activeTools.has(MEMORY_TOOLS.GLOBAL_SEARCH);
    const canStore = activeTools.has(MEMORY_TOOLS.STORE);
    if (!canSearch && !canStore) {
      recallDone = true;
      storeDone = true;
      return;
    }

    const memories = backend.localMemories().map((m) => ({ title: m.title }));
    if (memories.length === 0 && !canStore) {
      recallDone = true;
      return;
    }
    if (!canSearch || memories.length === 0) recallDone = true;
    if (!canStore) storeDone = true;

    let wake: string | undefined;
    if (cfg.wakeUp && wakeUpPromise) {
      wake =
        (await Promise.race([
          wakeUpPromise,
          new Promise<null>((r) => setTimeout(() => r(null), 1000)),
        ])) ?? undefined;
    }

    return {
      message: {
        customType: RECALL_CUSTOM_TYPE,
        content: buildMemoryRecallReminder({
          projectName: projectName(ctx.cwd),
          memories,
          canSearch,
          canStore,
          wakeUp: wake,
        }),
        display: true,
      },
    };
  });

  pi.on("agent_end", async (_event, _ctx) => {
    if (storeDone || !recallDone) return;
    if (!readMemoryConfig().write || overrides.write === false) return;
    if (!agentHooksEnabled()) return;
    if (!pi.getActiveTools().includes(MEMORY_TOOLS.STORE)) return;
    pi.sendMessage(
      {
        customType: RETRO_CUSTOM_TYPE,
        content: [
          "**🧠 Memory reminder:** If you learned something non-obvious in this task,",
          "call `memory_store` to save it as a memory for future sessions.",
          "Update existing memories instead of creating duplicates.",
        ].join(" "),
        display: true,
      },
      { deliverAs: "nextTurn" },
    );
  });

  pi.on("session_compact", async () => {
    recallDone = false;
  });

  pi.on("session_shutdown", async () => {
    if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
    replayKick = () => {};
    backend?.close();
    backend = null;
  });
}
