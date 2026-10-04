/**
 * @pi-unipi/info-screen — Extension entry
 *
 *   startup        Unicrab splash (non-capturing, self-dismissing)
 *   /unipi:info    the dashboard — This session first, then usage, tools, …
 *
 * Cache-first: the dashboard opens on memory/disk-cached data and refreshes
 * the visible page in the background.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_EVENTS, MODULES, UNIPI_PREFIX, emitEvent, getPackageVersion, type UnipiModuleEvent } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import {
  registerCoreGroups,
  trackModule,
  trackTool,
  setPiApi,
  setSessionContext,
  getTotalLoadTime,
  registerSkillDir,
  startLoadTracking,
  recordLoadTime,
  finishLoadTracking,
  setUpdateAvailable,
  splashFacts,
} from "./core-groups.js";
import { getInfoSettings } from "./config.js";
import { InfoOverlay } from "./tui/info-overlay.js";
import { renderSplash } from "./tui/splash.js";
import { flushUsageCache, usageCacheWarm } from "./usage-parser.js";
import { armSelfDismiss } from "./tui/self-dismiss.js";
import { getPiVersion, getInstalledPackageVersion, type UnipiUpdateAvailableEvent } from "@pi-unipi/core";

/** Re-export for external use */
export { infoRegistry, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking };

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

export default function (pi: ExtensionAPI) {
  setPiApi(pi);
  registerCoreGroups();
  startLoadTracking();

  // Debounced MODULE_READY handling — one cache invalidation per burst.
  let batch: Array<{ name: string; version: string; tools?: string[]; loadTimeMs?: number }> = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    const b = batch;
    batch = [];
    batchTimer = null;
    for (const e of b) {
      trackModule(e.name, e.version || "");
      recordLoadTime(e.name, "module", e.loadTimeMs);
      for (const t of e.tools ?? []) trackTool(t, e.name);
    }
    infoRegistry.invalidateCache("extensions");
    infoRegistry.invalidateCache("tools");
  };
  pi.events.on(UNIPI_EVENTS.MODULE_READY, (data) => {
    const e = data as UnipiModuleEvent;
    if (!e.name || e.name === MODULES.INFO_SCREEN) return;
    batch.push({ name: e.name, version: e.version, tools: e.tools, loadTimeMs: e.loadTimeMs });
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(flush, 150);
    batchTimer.unref?.();
  });

  // The session page reads the live context; keep it current and mark it
  // stale whenever the transcript moves.
  const touch = (ctx: ExtensionContext): void => {
    setSessionContext(ctx as never);
    infoRegistry.invalidateCache("session");
  };
  pi.on("turn_end", async (_e, ctx) => touch(ctx));
  pi.on("model_select", async (_e, ctx) => touch(ctx));

  function showDashboard(ctx: ExtensionContext, page?: string): void {
    setSessionContext(ctx as never);
    infoRegistry.invalidateCache("session");
    let overlay: InfoOverlay;
    void ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        overlay = new InfoOverlay(page);
        overlay.setTheme(theme);
        overlay.requestRender = () => tui.requestRender();
        overlay.terminalRows = () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
        overlay.onClose = () => {
          overlay.destroy();
          done();
        };
        // Live clock on the session page (durations) — 1 Hz, only while open.
        const tick = setInterval(() => tui.requestRender(), 1000);
        tick.unref?.();
        const stop = overlay.destroy.bind(overlay);
        overlay.destroy = () => {
          clearInterval(tick);
          stop();
        };
        return {
          render: (w: number) => overlay.render(w),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
          dispose: () => overlay.destroy(),
        };
      },
      {
        overlay: true,
        overlayOptions: () => ({ width: "86%", minWidth: 48, maxHeight: "92%", anchor: "center" as const, margin: 1 }),
      },
    );
  }

  pi.events.on(UNIPI_EVENTS.UPDATE_AVAILABLE, (data) => {
    setUpdateAvailable((data as UnipiUpdateAvailableEvent).latestVersion ?? null);
  });
  pi.events.on(UNIPI_EVENTS.UPDATE_APPLIED, () => setUpdateAvailable(null));

  /**
   * Unicrab splash. Auto-close mode is NON-capturing — it lives exactly while
   * the user starts typing, so it must never eat keys — and dismisses itself
   * stack-safely (see self-dismiss.ts). "on" mode captures and closes on any key.
   */
  function showSplash(ctx: ExtensionContext, autoCloseMs: number): void {
    const interactive = autoCloseMs <= 0;
    const unipiVersion = (() => {
      const v = getInstalledPackageVersion(ctx.cwd, "@pi-unipi/unipi");
      return v !== "0.0.0" ? v : VERSION;
    })();
    const piVersion = getPiVersion();
    const startedAt = Date.now();
    let destroyed = false;
    let cancelTimer = (): void => {};
    let anim: ReturnType<typeof setInterval> | null = null;
    let facts = splashFacts();
    const stop = (): void => {
      destroyed = true;
      cancelTimer();
      if (anim) clearInterval(anim);
      anim = null;
    };
    void ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const component = {
          render: (w: number) =>
            renderSplash({
              width: w,
              theme: theme as never,
              unipiVersion,
              piVersion,
              readyMs: getTotalLoadTimeSafe(),
              facts,
              remaining: interactive ? null : Math.max(0, 1 - (Date.now() - startedAt) / autoCloseMs),
              interactive,
            }),
          invalidate: () => {},
          handleInput: () => {
            stop();
            done();
          },
          dispose: stop,
        };
        // ~12 fps shimmer + countdown while visible; facts refresh once modules settle.
        anim = setInterval(() => {
          if (destroyed) return;
          tui.requestRender();
        }, 80);
        anim.unref?.();
        setTimeout(() => {
          if (!destroyed) facts = splashFacts();
        }, 300).unref?.();
        if (!interactive) {
          let handle: { hide?: () => void; setHidden?: (v: boolean) => void } | null = null;
          const isTopmostVisible = (): boolean => {
            try {
              const stack = (tui as unknown as { overlayStack?: Array<{ component?: unknown; hidden?: boolean }> }).overlayStack;
              if (!stack || stack.length === 0) return true;
              for (let i = stack.length - 1; i >= 0; i--) {
                const entry = stack[i];
                if (entry?.hidden) continue;
                return entry?.component === component;
              }
              return true;
            } catch {
              return true;
            }
          };
          cancelTimer = armSelfDismiss(autoCloseMs, {
            selfHide: () => {
              if (typeof handle?.hide === "function") handle.hide();
              else handle?.setHidden?.(true);
            },
            isTopmostVisible,
            isDestroyed: () => destroyed,
            destroy: stop,
          });
          splashHandleSink = (h) => {
            handle = h;
          };
        }
        return component;
      },
      {
        overlay: true,
        overlayOptions: () => ({ width: "78%", minWidth: 50, maxHeight: "80%", anchor: "center" as const, margin: 1, nonCapturing: !interactive }),
        onHandle: (h) => splashHandleSink?.(h as never),
      },
    );
  }
  let splashHandleSink: ((h: { hide?: () => void; setHidden?: (v: boolean) => void }) => void) | null = null;
  const getTotalLoadTimeSafe = (): number => {
    try {
      return getTotalLoadTime();
    } catch {
      return 0;
    }
  };

  pi.on("session_start", async (event, ctx) => {
    infoRegistry.setWorkspace(ctx.cwd);
    setSessionContext(ctx as never);
    finishLoadTracking();
    const settings = getInfoSettings();
    if (ctx.hasUI && event.reason === "startup" && settings.bootMode !== "off") {
      showSplash(ctx, settings.bootMode === "auto-close" ? Math.max(500, settings.bootTimeoutMs) : 0);
    }
    // Warm the usage page after boot settles — only when the parser's per-file
    // cache exists, so this is an incremental pass, never a cold multi-second parse.
    if (usageCacheWarm()) {
      setTimeout(() => void infoRegistry.getGroupData("usage"), 4000).unref?.();
    }
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.INFO_SCREEN,
      version: VERSION,
      commands: ["unipi:info"],
      tools: [],
    });
  });

  pi.on("session_shutdown", async () => {
    infoRegistry.writeSnapshot();
    flushUsageCache();
  });

  pi.registerCommand(`${UNIPI_PREFIX}info`, {
    description: "Dashboard: this session, usage, tools, skills, modules",
    getArgumentCompletions: (prefix: string) =>
      infoRegistry
        .getAllGroups()
        .map((g) => ({ value: g.id, label: g.id, description: g.name }))
        .filter((c) => c.value.startsWith(prefix.trim())),
    handler: async (args, ctx) => {
      showDashboard(ctx, args?.trim() || undefined);
    },
  });
}
