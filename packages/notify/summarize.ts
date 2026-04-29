/**
 * @pi-unipi/notify — Recap summarization
 *
 * Calls an LLM to summarize the last assistant message for push notifications.
 * Supports multiple API formats based on the model's api type.
 */

const SYSTEM_PROMPT =
  "Summarize this in one concise sentence for a push notification. Reply with ONLY the summary.";
const MAX_INPUT_CHARS = 2000;
const MAX_TOKENS = 100;
const TIMEOUT_MS = 10_000;
const FALLBACK_TRUNCATE_CHARS = 100;

/**
 * Summarize a message using an LLM.
 *
 * @param messageText - The assistant message text to summarize
 * @param apiKey - API key for the provider
 * @param baseUrl - Provider base URL (from Model.baseUrl)
 * @param api - API type (from Model.api, e.g. "openai-completions")
 * @param modelId - Model ID to use
 * @returns Summarized text, or truncated original on failure
 */
export async function summarizeLastMessage(
  messageText: string,
  apiKey: string,
  baseUrl: string,
  api: string,
  modelId: string,
): Promise<string> {
  // Truncate input if too long
  const input =
    messageText.length > MAX_INPUT_CHARS
      ? messageText.slice(0, MAX_INPUT_CHARS) + "..."
      : messageText;

  try {
    // Route to the correct API format
    if (api === "anthropic-messages") {
      return await callAnthropic(baseUrl, apiKey, modelId, input);
    }
    // Default: OpenAI-compatible (covers openai-completions, openai-responses, etc.)
    return await callOpenAICompatible(baseUrl, apiKey, modelId, input);
  } catch {
    return fallbackSummary(messageText);
  }
}

/** Call an OpenAI-compatible API (most providers) */
async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  input: string,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
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
      return fallbackSummary(input);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const summary = data.choices?.[0]?.message?.content?.trim();
    return summary && summary.length > 0 ? summary : fallbackSummary(input);
  } catch {
    clearTimeout(timeout);
    return fallbackSummary(input);
  }
}

/** Call the Anthropic Messages API */
async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  input: string,
): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, "")}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: input }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return fallbackSummary(input);
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };

    const textBlock = data.content?.find((b) => b.type === "text");
    const summary = textBlock?.text?.trim();
    return summary && summary.length > 0 ? summary : fallbackSummary(input);
  } catch {
    clearTimeout(timeout);
    return fallbackSummary(input);
  }
}

/** Truncate message as fallback when summarization fails */
function fallbackSummary(messageText: string): string {
  const trimmed = messageText.trim();
  if (trimmed.length <= FALLBACK_TRUNCATE_CHARS) return trimmed;
  return trimmed.slice(0, FALLBACK_TRUNCATE_CHARS) + "...";
}
