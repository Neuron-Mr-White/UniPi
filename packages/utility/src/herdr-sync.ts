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
}

/** Read Herdr environment (call once per session_start, cheap). */
export function detectHerdr(): HerdrEnv {
  const env = process.env.HERDR_ENV;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (env === "1" && socketPath && paneId) {
    return { enabled: true, socketPath, paneId };
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

/**
 * Push the session name to Herdr as the pane title.
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
}
