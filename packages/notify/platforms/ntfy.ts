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
 */

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
   *  the user's `notify.ntfy.appDetail` setting. */
  appDetail?: "minimal" | "full";
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

/** Builds the ntfy JSON publish body shared by the topic send and every
 * registered app-endpoint send (UNI-161 §4b: notify_register{endpoint}). */
export function buildNtfyBody(
  topic: string,
  title: string,
  message: string,
  priority: number,
  options?: NtfyPublishOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    topic,
    title,
    message: options?.appDetail === "full" || !options?.route ? message : "Tap to open in UniPi",
    priority: Math.max(1, Math.min(5, priority)),
  };
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
  const body: Record<string, unknown> = {
    title,
    message: options?.appDetail === "full" || !options?.route ? message : "Tap to open in UniPi",
    priority: Math.max(1, Math.min(5, priority)),
  };
  if (options?.route) {
    body.click = buildDeepLink(options.route);
    if (options.route.kind) body.tags = [options.route.kind];
  }
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
