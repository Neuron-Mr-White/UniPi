/**
 * @pi-unipi/unipi — All-in-one extension entry
 *
 * Loads every Unipi module in a single entry point.
 * Think of this as the "oh-my-zsh" for pi — one install mounts all modules.
 *
 * Usage:
 *   pi --no-extensions --no-skills -e packages/unipi/index.ts
 *   mise run unipi
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { installArbiter, installHarnessProvenance, installPendingWorkMonitor, migrateState, sweepOrphanSessions, withCommandEcho } from "@pi-unipi/core";
import { withHarnessToolAnnotations } from "@pi-unipi/utility";
import { readUtilSettings, simpleWrapTool, simpleWrapped, installSimpleGroupEvents } from "@pi-unipi/utility";

import workflow from "@pi-unipi/workflow";
import longHorizon from "@pi-unipi/long-horizon";
import memory from "@pi-unipi/memory";
import infoScreen from "@pi-unipi/info-screen";
import subagents from "@pi-unipi/subagents";
import backgroundTasks from "@pi-unipi/background-tasks";
import btw from "@pi-unipi/btw/extensions/btw.js";
import webApi from "@pi-unipi/web-api";
import utility from "@pi-unipi/utility";
import skillRegistry from "@pi-unipi/skill-registry";
import askUser from "@pi-unipi/ask-user";
import mcp from "@pi-unipi/mcp";
import notify from "@pi-unipi/notify";
import kanboard from "@pi-unipi/kanboard";
import commandEnchantment from "@pi-unipi/command-enchantment";
import compactor from "@pi-unipi/compactor";
import footer from "@pi-unipi/footer";
import updater from "@pi-unipi/updater";
import inputShortcuts from "@pi-unipi/input-shortcuts";
import fusion from "@pi-unipi/fusion";
import watchdog from "@pi-unipi/watchdog";
import appBridge from "@pi-unipi/app-bridge";

export default function (pi: ExtensionAPI) {
  const api = withCommandEcho(pi);
  // Harness provenance must observe every input/send — install before modules.
  try {
    installHarnessProvenance(api);
  } catch {
    // Provenance is cosmetic; never blocks startup.
  }
  // The turn arbiter must own the single agent_before_settle handler BEFORE
  // any module mounts (idempotent; a no-op in child processes).
  try {
    installArbiter(pi);
  } catch {
    // Never block startup on the arbiter.
  }
  // UNI-162: one pending-work monitor reading the arbiter's own wait sources
  // (idempotent; a no-op in child processes).
  try {
    installPendingWorkMonitor(pi);
  } catch {
    // Never block startup on the monitor.
  }
  // "simple" render style = mcode transcript: every tool registered by any
  // unipi module is captured here and, after all modules load, re-registered
  // with the collapsed one-liner wrapper (execute/schema untouched; Ctrl+O
  // falls back to the tool's own renderer). best-effort, never blocks load.
  const captured = new Map<string, ToolDefinition<any, any, any>>();
  const rawRegister = api.registerTool.bind(api);
  const registering = new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (tool: ToolDefinition<any, any, any>) => {
          // Harness tool-annotation wrapper (idempotent, applied BEFORE the
          // simple-mode wrapper so simpleResult hooks merge).
          const wrapped = withHarnessToolAnnotations(tool);
          captured.set(tool.name, wrapped);
          return rawRegister(wrapped);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  // One-time v3 state relocation into ~/.unipi/{global,workspace}/, then reap
  // any dead-pid session dirs left by crashed sessions. Both are best-effort
  // and version/pid-gated, so they are cheap on every subsequent startup.
  try {
    migrateState();
    sweepOrphanSessions();
  } catch {
    // Never block startup on housekeeping.
  }

  // Per-module registration time + what each module registered (tools,
  // commands, shortcuts), read by the info screen's
  // Modules page. Captured by wrapping the api for the duration of load().
  const loadTimes: Record<string, number> = {};
  const contributions: Record<string, { tools: string[]; commands: string[]; shortcuts: number }> = {};
  const g = globalThis as { __unipi_load_times?: Record<string, number>; __unipi_contributions?: typeof contributions };
  g.__unipi_load_times = loadTimes;
  g.__unipi_contributions = contributions;
  const load = (name: string, extension: (api: ExtensionAPI) => void) => {
    const c: { tools: string[]; commands: string[]; shortcuts: number } = (contributions[name] = { tools: [], commands: [], shortcuts: 0 });
    const tracking = new Proxy(registering, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        if (prop === "registerTool") return (t: { name: string }, ...rest: unknown[]) => (c.tools.push(t.name), (v as Function).call(target, t, ...rest));
        if (prop === "registerCommand") return (n: string, ...rest: unknown[]) => (c.commands.push(n), (v as Function).call(target, n, ...rest));
        if (prop === "registerShortcut") return (...a: unknown[]) => (c.shortcuts++, (v as Function).apply(target, a));
        return v;
      },
    });
    const t0 = performance.now();
    try {
      extension(tracking as ExtensionAPI);
    } finally {
      loadTimes[name] = Math.round((performance.now() - t0) * 10) / 10;
    }
  };

  load("workflow", workflow);
  load("long-horizon", longHorizon);
  load("memory", memory);
  load("utility", utility);
  load("skill-registry", skillRegistry);
  load("info-screen", infoScreen);
  load("subagents", subagents);
  load("background-tasks", backgroundTasks);
  load("btw", btw);
  load("web-api", webApi);
  load("ask-user", askUser);
  load("mcp", mcp);
  load("notify", notify);
  load("kanboard", kanboard);
  load("command-enchantment", commandEnchantment);
  load("compactor", compactor);
  load("footer", footer);
  load("updater", updater);
  load("input-shortcuts", inputShortcuts);
  load("fusion", fusion);
  load("watchdog", watchdog);
  load("app-bridge", appBridge);

  // After all modules registered: apply the mcode-style wrapper. Re-register
  // with the RAW register (not the capturing proxy) to avoid double-capture.
  if (readUtilSettings().render.style === "simple") {
    installSimpleGroupEvents(api);
    for (const def of captured.values()) {
      if (simpleWrapped.has(def)) continue;
      try {
        rawRegister(simpleWrapTool(def));
      } catch {
        // keep the original tool on any failure
      }
    }
  }
}
