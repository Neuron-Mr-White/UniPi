/**
 * @pi-unipi/kanboard — Copy Button Component
 *
 * Reusable copy-to-clipboard button with visual feedback.
 */

/** Escape HTML */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a copy-to-clipboard button.
 *
 * @param text - Text to copy
 * @param label - Optional display label (defaults to text truncated)
 */
export function renderCopyButton(text: string, label?: string): string {
  const displayLabel = label ?? (text.length > 40 ? text.slice(0, 37) + "..." : text);
  return `<button class="copy-btn" onclick="copyToClipboard('${esc(text)}', event)" title="${esc(text)}">📋 ${esc(displayLabel)}</button>`;
}
