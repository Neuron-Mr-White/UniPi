/**
 * @unipi/memory — /unipi:memory + the v2 command surface
 *
 * `status` — backend, daemon, reader, counts, switches, pending ops,
 * migration state. `recall on|off` / `write on|off` — session-only
 * overrides. `migrate` — the one-way v2 conversion, run only after the
 * plan is shown and confirmed. The v2 commands are thin shims that send
 * the same follow-up messages / notifications v2 did.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionBackend } from "./session.js";
import { MEMORY_TOOLS } from "./tools.js";
import { readMemoryConfig } from "./settings.js";
import { readPending } from "./pending.js";
import { needsMigration, readConversionState, runConversion } from "./convert.js";
import { probeDaemon } from "./mempalace.js";
import { DEFAULT_PALACE } from "./mempalace.js";
import { memoryRoot, sanitizeProjectName } from "./paths.js";
import { listProjectDirs } from "./files.js";

export interface SessionOverrides {
  recall?: boolean;
  write?: boolean;
}

interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

/** Argument completions for `/unipi:memory` — incl. `migrate`. */
export function memoryCompletions(prefix: string): CompletionItem[] | null {
  const raw = prefix.replace(/^\s+/, "");
  const recallMatch = /^(recall|write)\s+(\S*)$/.exec(raw);
  if (recallMatch) {
    const partial = recallMatch[2];
    return ["on", "off"]
      .filter((v) => v.startsWith(partial))
      .map((v) => ({ value: `${recallMatch[1]} ${v}`, label: v }));
  }
  const subs: CompletionItem[] = [
    { value: "status", label: "status", description: "backend, daemon, reader, counts, switches, migration" },
    { value: "migrate", label: "migrate", description: "convert v2 memories (backups included, one-way)" },
    { value: "recall on", label: "recall on", description: "session-only: put memory in front of the agent" },
    { value: "recall off", label: "recall off", description: "session-only: no start reminder" },
    { value: "write on", label: "write on", description: "session-only: memory_store/delete active" },
    { value: "write off", label: "write off", description: "session-only: read-only tools" },
  ];
  return subs.filter((item) => item.value.startsWith(raw));
}

/** Count v2 leftovers for the migrate plan. */
export function legacyInventory(): {
  flatFiles: number;
  nonSanitizedDirs: string[];
  markers: string[];
} {
  const root = memoryRoot();
  const out = { flatFiles: 0, nonSanitizedDirs: [] as string[], markers: [] as string[] };
  if (!fs.existsSync(root)) return out;
  for (const marker of [".mempalace-ledger.json", ".mempalace-migrated"]) {
    if (fs.existsSync(path.join(root, marker))) out.markers.push(marker);
  }
  for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirEnt.isDirectory() || dirEnt.name.startsWith(".")) continue;
    if (dirEnt.name !== sanitizeProjectName(dirEnt.name)) out.nonSanitizedDirs.push(dirEnt.name);
    const dir = path.join(root, dirEnt.name);
    try {
      out.flatFiles += fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md")).length;
    } catch { /* unreadable */ }
  }
  return out;
}

export function registerMemoryCommands(
  pi: ExtensionAPI,
  backend: () => SessionBackend | null,
  overrides: SessionOverrides,
): void {
  const applyWriteToggle = (on: boolean) => {
    overrides.write = on;
    const active = new Set(pi.getActiveTools());
    const memTools = new Set<string>([MEMORY_TOOLS.STORE, MEMORY_TOOLS.DELETE]);
    if (on) {
      for (const t of memTools) active.add(t);
    } else {
      for (const t of memTools) active.delete(t);
    }
    pi.setActiveTools([...active]);
  };

  pi.registerCommand("unipi:memory", {
    description: "Memory status and session overrides: /unipi:memory status|recall on|off|write on|off|migrate",
    getArgumentCompletions: (prefix: string) => memoryCompletions(prefix ?? ""),
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "status";
      const b = backend();

      if (sub === "status") {
        const cfg = readMemoryConfig();
        const daemon = await probeDaemon(DEFAULT_PALACE);
        const readerUp = b?.reader ? await b.reader.status().then((s) => !!s).catch(() => false) : false;
        const counts = b ? (await b.list()).length : 0;
        const pending = readPending();
        const conv = readConversionState();
        const lines = [
          `backend: ${b?.install ? `mempalace ${b.install.version}` : "unavailable"}${b?.mode === "local" ? " (markdown-only)" : ""}`,
          `daemon: ${daemon.reachable ? `up${daemon.busy ? " (busy)" : ""}` : "down"}`,
          `reader: ${readerUp ? "warm" : "down"}`,
          `project memories: ${counts} (${b?.project ?? "?"})`,
          `pending ops: ${pending.length}`,
          ...(pending.some((o) => o.heldBy)
            ? [`palace busy: held by ${pending.find((o) => o.heldBy)?.heldBy}`]
            : []),
          `switches: recall=${cfg.recallAtStart && overrides.recall !== false} write=${cfg.write && overrides.write !== false} wakeUp=${cfg.wakeUp} autoStartDaemon=${cfg.autoStartDaemon}`,
          ...(overrides.recall !== undefined ? [`session recall override: ${overrides.recall}`] : []),
          ...(overrides.write !== undefined ? [`session write override: ${overrides.write}`] : []),
        ];
        if (b?.installIssue) lines.push(`mode: ${b.installIssue}`);
        if (conv) {
          lines.push(`migration: ${conv.phase} ${conv.done}/${conv.total} · ${conv.failedUnits ?? 0} failed${conv.errors.length ? ` (${conv.errors.length} errors)` : ""}`);
          if (conv.backupPath) lines.push(`palace backup: ${conv.backupPath}`);
          if (conv.mdBackupPath) lines.push(`memory backup: ${conv.mdBackupPath}`);
        } else if (needsMigration()) {
          lines.push("migration: needed — run /unipi:memory migrate");
        } else {
          lines.push("migration: not needed");
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "migrate") {
        if (!needsMigration()) {
          const conv = readConversionState();
          ctx.ui.notify(
            conv?.phase === "done"
              ? `Nothing to migrate — conversion finished (${conv.total} records).${conv.backupPath ? `\nBackups: ${conv.backupPath}${conv.mdBackupPath ? `, ${conv.mdBackupPath}` : ""}` : ""}`
              : "Nothing to migrate.",
            "info",
          );
          return;
        }
        const inProgress = readConversionState();
        const inv = legacyInventory();
        const est = Math.max(1, Math.ceil(inv.flatFiles / 300));
        const plan = [
          "Migration plan (one-way):",
          `· ${inv.flatFiles} flat memory files → typed layout + mined into the palace`,
          `· ${inv.nonSanitizedDirs.length} project dirs renamed to lowercase (${inv.nonSanitizedDirs.slice(0, 5).join(", ")}${inv.nonSanitizedDirs.length > 5 ? "…" : ""})`,
          inv.markers.length ? `· legacy markers removed: ${inv.markers.join(", ")}` : "",
          `· roughly ~${est} min plus old-drawer cleanup`,
          "· backups first: palace → ~/.mempalace/palace.bak-unipi-<ts>, memory tree → ~/.unipi/memory-v2-backup-<ts>",
          "· a temporary MemPalace daemon runs during migration; MemPalace MCP servers in other tools are read-only until it finishes",
          "· going back is a backup restore — see README",
          inProgress && inProgress.phase !== "done" && inProgress.phase !== "failed"
            ? `· resumes the in-progress conversion (${inProgress.phase} ${inProgress.done}/${inProgress.total})`
            : "",
        ].filter(Boolean).join("\n");
        const ok = await ctx.ui.confirm("Migrate memories now?", plan);
        if (!ok) {
          ctx.ui.notify("Migration cancelled.", "info");
          return;
        }
        if (!b?.install || !b.reader) {
          ctx.ui.notify("Migration needs a working MemPalace install + reader — check /unipi:memory status.", "warning");
          return;
        }
        ctx.ui.notify("Migrating in the background — watch the footer / /unipi:memory status.", "info");
        void (async () => {
          // runConversion is resumable, not self-driving — keep calling until
          // it reaches a terminal phase (one call can return early to retry
          // failed mine batches or wait on a paused reader).
          let final = await runConversion({ install: b.install!, reader: b.reader! }).catch(() => null);
          for (let i = 0; i < 100 && final && final.phase !== "done" && final.phase !== "failed"; i++) {
            await new Promise((r) => setTimeout(r, 3_000));
            final = await runConversion({ install: b.install!, reader: b.reader! }).catch(() => final);
          }
          const backups = final?.backupPath || final?.mdBackupPath
            ? `\nBackups: ${[final?.backupPath, final?.mdBackupPath].filter(Boolean).join(", ")}`
            : "";
          ctx.ui.notify(
            final?.phase === "done"
              ? `Memory migration complete — ${final.done}/${final.total} records${final.failedUnits ? ` · ${final.failedUnits} failed` : ""}.${backups}`
              : `Memory migration ${final?.phase ?? "failed"}${final?.errors.length ? ` — ${final.errors.length} errors` : ""}.${backups}`,
            final?.phase === "done" ? "info" : "warning",
          );
        })();
        return;
      }

      if (sub === "recall" || sub === "write") {
        const val = parts[1];
        if (val !== "on" && val !== "off") {
          ctx.ui.notify(`Usage: /unipi:memory ${sub} on|off`, "warning");
          return;
        }
        const on = val === "on";
        if (sub === "recall") {
          overrides.recall = on;
          ctx.ui.notify(`Memory recall ${on ? "on" : "off"} for this session.`, "info");
        } else {
          applyWriteToggle(on);
          ctx.ui.notify(`Memory write ${on ? "on" : "off"} for this session.`, "info");
        }
        return;
      }

      ctx.ui.notify("Usage: /unipi:memory status | migrate | recall on|off | write on|off", "info");
    },
  });

  // ── v2 command surface (thin shims — same messages and notifications) ──

  pi.registerCommand("unipi:memory-process", {
    description: "Analyze text and store extracted memories",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:memory-process <text to analyze>", "info");
        return;
      }
      ctx.ui.notify("Analyzing text for memories... Use memory_store tool to save.", "info");
      pi.sendUserMessage(
        `Analyze the following text and extract any memory-worthy items (user preferences, project decisions, code patterns, conversation summaries). For each item found, use the memory_store tool to save it.\n\nText to analyze:\n${args}`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("unipi:memory-consolidate", {
    description: "Consolidate current session into memory",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Consolidating session into memory... Use memory_store tool to save insights.", "info");
      pi.sendUserMessage(
        `Review the current session and identify any memory-worthy items:
- User preferences discovered
- Project decisions made
- Code patterns learned
- Important context to remember

For each item, use the memory_store tool to save it with an appropriate title and type.`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("unipi:memory-search", {
    description: "Search project memories",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:memory-search <search term>", "info");
        return;
      }
      const b = backend();
      const results = b ? await b.search(args.trim(), 10, "project") : [];
      if (results.length === 0) {
        ctx.ui.notify(`No memories found for: "${args}"`, "info");
        return;
      }
      const output = results
        .map((r, i) => `${i + 1}. ${r.title} (${r.room})\n   ${r.snippet}`)
        .join("\n\n");
      ctx.ui.notify(`Found ${results.length} memories:\n\n${output}`, "info");
    },
  });

  pi.registerCommand("unipi:global-memory-search", {
    description: "Search memories across all projects",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:global-memory-search <search term>", "info");
        return;
      }
      const b = backend();
      const results = b ? await b.search(args.trim(), 10, "all") : [];
      if (results.length === 0) {
        ctx.ui.notify(`No memories found across projects for: "${args}"`, "info");
        return;
      }
      const output = results
        .map((r, i) => `${i + 1}. [${r.wing}] ${r.title} (${r.room})\n   ${r.snippet}`)
        .join("\n\n");
      ctx.ui.notify(`Found ${results.length} memories across projects:\n\n${output}`, "info");
    },
  });

  pi.registerCommand("unipi:memory-forget", {
    description: "Delete a memory by title",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:memory-forget <memory title>", "info");
        return;
      }
      const b = backend();
      const res = b ? await b.delete(b.project, args.trim()) : { found: false };
      ctx.ui.notify(res.found ? `Deleted memory: ${args}` : `Memory not found: ${args}`, "info");
    },
  });

  pi.registerCommand("unipi:global-memory-list", {
    description: "List all memories across all projects",
    handler: async (_args, ctx) => {
      const b = backend();
      if (!b) {
        ctx.ui.notify("Memory backend unavailable.", "info");
        return;
      }
      const grouped = new Map<string, Array<{ id: string; title: string; type: string }>>();
      for (const { name } of listProjectDirs()) {
        const p = sanitizeProjectName(name);
        for (const m of await b.list(p)) {
          grouped.set(p, [...(grouped.get(p) ?? []), m]);
        }
      }
      if (grouped.size === 0) {
        ctx.ui.notify("No memories stored in any project.", "info");
        return;
      }
      let output = "";
      let total = 0;
      for (const [project, mems] of grouped) {
        total += mems.length;
        output += `\n${project} (${mems.length}):\n`;
        for (const m of mems) output += `  - ${m.title} (${m.type})\n`;
      }
      ctx.ui.notify(`All memories across ${grouped.size} projects (${total} total):${output}`, "info");
    },
  });
}
