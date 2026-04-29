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
  const url = `${serverUrl.replace(/\/$/, "")}/${topic}`;
  const headers: Record<string, string> = {
    Title: title,
    Priority: String(Math.max(1, Math.min(5, priority))),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: message,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`ntfy API error ${response.status}: ${body}`);
  }
}
