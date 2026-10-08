/**
 * @pi-unipi/notify — ntfy notification platform
 *
 * Sends push notifications to an ntfy server via HTTP POST.
 * ntfy is a simple HTTP-based pub-sub notification service.
 * Supports self-hosted instances and ntfy.sh (public).
 *
 * UNI-161 §4: app routing data (`click` deep link, `tags`) so the UniPi app
 * can route a tapped notification straight to the right chat/dialog, plus
 * `appDetail` to control how much of the prompt text ntfy ever carries (the
 * server-side notify config has no app secrets, but "minimal" keeps the
 * question text itself off a third-party ntfy.sh server by default).
 *
 * UNI-161 §1: when `encryptKey` is set (notify-key.ts), the whole payload
 * is AES-256-GCM-encrypted (ntfy-crypto.ts) into the ntfy `message`; the
 * ntfy `title` is pinned to a fixed neutral "UniPi" and `click` carries no
 * content beyond host/pid/dialog (deep-link routing only, never prompt
 * text) — so a self-hosted *or* public ntfy server only ever sees
 * ciphertext. Without a key: unchanged legacy minimal/full behaviour.
 */
import { encryptNotifyPayload } from "../ntfy-crypto.js";

/** What the phone needs to open the right chat (UNI-161 §4): the deep link's
 * query params. `host`: the paired host's id, or (when unknown on the pi
 * side) the machine hostname — the app maps hostname → paired host. */
export interface NtfyAppRoute {
  host: string;
  pid?: number;
  dialog?: number;
  /** ask_user / permission_request / input_needed / agent_end / … — becomes an ntfy tag too. */
  kind?: string;
}

export interface NtfyPublishOptions {
  /** Deep link opened on tap (also attached as `click`). */
  route?: NtfyAppRoute;
  /** "minimal" (default): generic title/message, no prompt text — only the
   *  route data. "full": the message argument is sent as-is. Controlled by
   *  the user's `notify.ntfy.appDetail` setting. Also governs whether the
   *  encrypted payload (when `encryptKey` is set) includes the message
   *  text or just a generic body. */
  appDetail?: "minimal" | "full";
  /** UNI-161 §1: the per-pairing E2E key. When present, the payload is
   *  encrypted end to end and `appDetail`/`route` only ever affect what
   *  goes *inside* the ciphertext, never the ntfy title/message/click. */
  encryptKey?: Buffer;
  /** Folded into the encrypted payload (ignored without `encryptKey`). */
  session?: string;
  dialogId?: number;
}

/** `unipi://chat?host=<id>&pid=<pid>&dialog=<id>` — the app's existing
 * pairing deep-link scheme, reused for chat routing (UNI-161 §4). */
export function buildDeepLink(route: NtfyAppRoute): string {
  const params = new URLSearchParams();
  params.set("host", route.host);
  if (route.pid !== undefined) params.set("pid", String(route.pid));
  if (route.dialog !== undefined) params.set("dialog", String(route.dialog));
  return `unipi://chat?${params.toString()}`;
}

/** The fixed neutral ntfy title used once a payload is encrypted — the
 * server must never see a hint of the real title. */
const ENCRYPTED_TITLE = "UniPi";

/** Builds the ntfy JSON publish body shared by the topic send and every
 * registered app-endpoint send (UNI-161 §4b: notify_register{endpoint}).
 * `topicField` lets `publishToEndpoint` omit the `topic` key (the endpoint
 * URL already names it) while sharing the same body-building logic. */
export function buildNtfyBody(
  topicOrNull: string | null,
  title: string,
  message: string,
  priority: number,
  options?: NtfyPublishOptions,
): Record<string, unknown> {
  const clamped = Math.max(1, Math.min(5, priority));
  if (options?.encryptKey) {
    const route = options.route;
    const envelope = encryptNotifyPayload(options.encryptKey, {
      title,
      body: options.appDetail === "full" || !route ? message : "Tap to open in UniPi",
      kind: route?.kind,
      host: route?.host,
      pid: route?.pid,
      session: options.session,
      dialogId: options.dialogId,
    });
    const body: Record<string, unknown> = {
      title: ENCRYPTED_TITLE,
      message: envelope,
      priority: clamped,
    };
    if (topicOrNull !== null) body.topic = topicOrNull;
    // The click target itself must stay content-free: host/pid/dialog
    // only, same shape as the unencrypted route, never prompt text.
    if (route) body.click = buildDeepLink(route);
    return body;
  }
  const body: Record<string, unknown> = {
    title,
    message: options?.appDetail === "full" || !options?.route ? message : "Tap to open in UniPi",
    priority: clamped,
  };
  if (topicOrNull !== null) body.topic = topicOrNull;
  if (options?.route) {
    body.click = buildDeepLink(options.route);
    if (options.route.kind) body.tags = [options.route.kind];
  }
  return body;
}

/** Send a notification to an ntfy server */
export async function sendNtfyNotification(
  serverUrl: string,
  topic: string,
  title: string,
  message: string,
  priority: number = 3,
  token?: string,
  options?: NtfyPublishOptions,
): Promise<void> {
  // ntfy supports POSTing to the server root with a JSON body that carries
  // topic/title/message/priority. JSON bodies are UTF-8 safe, unlike HTTP
  // headers which must be ByteString (Latin-1) and reject characters like
  // em dash (U+2014). See https://docs.ntfy.sh/publish/#publish-as-json
  const url = serverUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const body = JSON.stringify(buildNtfyBody(topic, title, message, priority, options));

  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const resBody = await response.text().catch(() => "<no body>");
    throw new Error(`ntfy API error ${response.status}: ${resBody}`);
  }
}

/**
 * Posts to a registered phone UniPi UnifiedPush endpoint (UNI-161 §4b): the
 * endpoint URL IS an ntfy topic (ntfy's UnifiedPush distributor exposes
 * `https://<server>/<random-topic>`), so the same JSON publish shape works —
 * just no `topic` field (the URL already names it) and no auth header (the
 * phone's own distributor owns that connection, not this ntfy account).
 * Best-effort: endpoint failures never block the primary ntfy send.
 */
export async function publishToEndpoint(endpoint: string, title: string, message: string, priority: number, options?: NtfyPublishOptions): Promise<void> {
  const body = buildNtfyBody(null, title, message, priority, options);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const resBody = await response.text().catch(() => "<no body>");
    throw new Error(`endpoint publish error ${response.status}: ${resBody}`);
  }
}
