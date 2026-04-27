/**
 * @pi-unipi/notify — Gotify notification platform
 *
 * Sends push notifications to a Gotify server via HTTP POST.
 * Gotify is a self-hosted push notification server.
 */

/** Send a notification to Gotify server */
export async function sendGotifyNotification(
  serverUrl: string,
  appToken: string,
  title: string,
  message: string,
  priority: number = 5
): Promise<void> {
  const url = serverUrl.replace(/\/$/, "") + "/message";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gotify-Key": appToken,
    },
    body: JSON.stringify({
      title,
      message,
      priority,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(
      `Gotify API error ${response.status}: ${body}`
    );
  }
}
