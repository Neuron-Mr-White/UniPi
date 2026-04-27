/**
 * @pi-unipi/notify — Telegram notification platform
 *
 * Sends notifications via Telegram Bot API.
 * Supports auto-detection of chat ID via polling getUpdates.
 */

/** Send a notification via Telegram Bot API */
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  title: string,
  message: string
): Promise<void> {
  const text = `*${escapeMarkdown(title)}*\n${escapeMarkdown(message)}`;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "MarkdownV2",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(
      `Telegram API error ${response.status}: ${body}`
    );
  }
}

/**
 * Poll Telegram getUpdates to detect the chat ID from a user message.
 * Returns the chat ID string, or null if no message found.
 */
export async function pollForChatId(
  botToken: string,
  signal?: AbortSignal
): Promise<string | null> {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates?allowed_updates=["message"]`;

  try {
    const response = await fetch(url, { signal });
    const data = (await response.json()) as {
      ok: boolean;
      result: Array<{
        message?: { chat?: { id?: number } };
        callback_query?: { message?: { chat?: { id?: number } } };
      }>;
    };

    if (data.ok && data.result.length > 0) {
      const lastUpdate = data.result[data.result.length - 1];
      const chatId =
        lastUpdate.message?.chat?.id ||
        lastUpdate.callback_query?.message?.chat?.id;
      if (chatId) {
        return String(chatId);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // Network error — return null to allow retry
    return null;
  }

  return null;
}

/** Escape special MarkdownV2 characters */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
