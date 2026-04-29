/**
 * @pi-unipi/notify — Recap summarization
 *
 * Calls an LLM to summarize the last assistant message for push notifications.
 * Uses direct fetch to OpenRouter API with fallback to truncated message.
 */

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const SYSTEM_PROMPT =
  "Summarize this in one concise sentence for a push notification. Reply with ONLY the summary.";
const MAX_INPUT_CHARS = 2000;
const MAX_TOKENS = 100;
const TIMEOUT_MS = 10_000;
const FALLBACK_TRUNCATE_CHARS = 100;

/**
 * Summarize a message using an LLM via OpenRouter API.
 *
 * @param messageText - The assistant message text to summarize
 * @param apiKey - OpenRouter API key
 * @param model - Model ID (e.g. "openai/gpt-oss-20b")
 * @returns Summarized text, or truncated original on failure
 */
export async function summarizeLastMessage(
  messageText: string,
  apiKey: string,
  model: string,
): Promise<string> {
  // Truncate input if too long
  const input =
    messageText.length > MAX_INPUT_CHARS
      ? messageText.slice(0, MAX_INPUT_CHARS) + "..."
      : messageText;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return fallbackSummary(messageText);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const summary = data.choices?.[0]?.message?.content?.trim();
    if (summary && summary.length > 0) {
      return summary;
    }

    return fallbackSummary(messageText);
  } catch {
    return fallbackSummary(messageText);
  }
}

/** Truncate message as fallback when summarization fails */
function fallbackSummary(messageText: string): string {
  const trimmed = messageText.trim();
  if (trimmed.length <= FALLBACK_TRUNCATE_CHARS) return trimmed;
  return trimmed.slice(0, FALLBACK_TRUNCATE_CHARS) + "...";
}
