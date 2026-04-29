/**
 * @pi-unipi/notify — ntfy notification platform
 *
 * Sends push notifications to an ntfy server via HTTP POST.
 * ntfy is a simple HTTP-based pub-sub notification service.
 * Supports self-hosted instances and ntfy.sh (public).
 */

/** Send a notification to an ntfy server */
export async function sendNtfyNotification(
  serverUrl: string,
  topic: string,
  title: string,
  message: string,
  priority: number = 3,
  token?: string
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

  const body = JSON.stringify({
    topic,
    title,
    message,
    priority: Math.max(1, Math.min(5, priority)),
  });

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
