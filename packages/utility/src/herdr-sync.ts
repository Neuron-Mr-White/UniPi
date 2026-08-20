/**
 * @pi-unipi/utility — Herdr pane title sync
 *
 * When running inside a Herdr pane, pushes the pi session name to Herdr's
 * socket API (`pane.report_metadata` with `title`). Herdr displays the title
 * in the pane border / agent panel — always visible, never scrolls away.
 *
 * This is the scroll-proof session name display: the in-TUI badge overlay
 * scrolls with content (pi renders to the primary buffer), but Herdr's pane
 * border is drawn by Herdr itself outside the terminal scrollback.
 *
 * Detection: Herdr sets HERDR_ENV=1 and HERDR_SOCKET_PATH + HERDR_PANE_ID
 * in every pane it spawns (same env the official herdr-pi integration uses).
 */

import { createConnection } from "node:net";

/** Push timeout — never block the agent on a slow socket. */
const SEND_TIMEOUT_MS = 500;

export interface HerdrEnv {
  enabled: boolean;
  socketPath?: string;
  paneId?: string;
  tabId?: string;
}

/** Read Herdr environment (call once per session_start, cheap). */
export function detectHerdr(): HerdrEnv {
  const env = process.env.HERDR_ENV;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  if (env === "1" && socketPath && paneId) {
    return { enabled: true, socketPath, paneId, tabId };
  }
  return { enabled: false };
}

function sendRequest(socketPath: string, request: unknown): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve();
    };
    const socket = createConnection(socketPath);
    socket.on("error", finish);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", finish);
    socket.on("end", finish);
    const timeout = setTimeout(finish, SEND_TIMEOUT_MS);
    timeout.unref?.();
  });
}

let reportSeq = Date.now();

/** Only rename the tab when its label is a default numeric one (1-3 digits) — never clobber a user-set name. */
const DEFAULT_TAB_LABEL = /^\d{1,3}$/;

async function fetchJson(socketPath: string, method: string, params: Record<string, unknown>, extract: (result: any) => Record<string, unknown> | null): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.on("error", () => finish(null));
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: `unipi:fetch:${method}:${Date.now()}`, method, params })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      try {
        const parsed = JSON.parse(buffer);
        finish(extract(parsed?.result));
      } catch {
        /* keep buffering */
      }
    });
    socket.on("end", () => finish(null));
    const timeout = setTimeout(() => finish(null), SEND_TIMEOUT_MS);
    timeout.unref?.();
  });
}

/**
 * Push the session name to Herdr as the pane title, and as the tab label
 * when the tab still has its default numeric label.
 * Fire-and-forget: never throws, resolves after send timeout at worst.
 */
export async function syncPaneTitle(env: HerdrEnv, sessionName: string | null): Promise<void> {
  if (!env.enabled || !env.socketPath || !env.paneId) return;
  reportSeq += 1;
  const params: Record<string, unknown> = {
    pane_id: env.paneId,
    source: "unipi:badge",
    seq: reportSeq,
  };
  if (sessionName) {
    params.title = sessionName;
  } else {
    params.clear_title = true;
  }
  // Best effort — errors are swallowed by sendRequest's error handler.
  await sendRequest(env.socketPath, {
    id: `unipi:badge:title:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_metadata",
    params,
  });

  // Also sync the tab label so the name is visible in the tab bar (single-pane
  // tabs don't render pane borders, so the pane title alone is invisible there).
  // Only rename when the label is still the default numeric one — a user-set
  // name always wins.
  if (sessionName && env.tabId) {
    const tab = await fetchJson(env.socketPath, "tab.get", { tab_id: env.tabId }, (r) => r?.tab ?? null);
    const label = tab?.label;
    if (typeof label !== "string" || DEFAULT_TAB_LABEL.test(label)) {
      await sendRequest(env.socketPath, {
        id: `unipi:badge:tab:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: "tab.rename",
        params: { tab_id: env.tabId, label: sessionName },
      });
    }
  }
}
