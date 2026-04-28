/**
 * @pi-unipi/kanboard — Checklist Component
 *
 * Reusable checklist renderer with status indicators and copy buttons.
 */

import type { ParsedItem } from "../../types.js";

/** Escape HTML */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Status icon */
function statusIcon(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "in-progress":
      return "◐";
    default:
      return "○";
  }
}

/**
 * Render a checklist of items.
 */
export function renderChecklist(items: ParsedItem[]): string {
  if (items.length === 0) {
    return '<div class="empty-state"><p class="empty-state-text">No items</p></div>';
  }

  const rows = items
    .map(
      (item) => `
    <li class="checklist-item">
      <span class="checklist-status ${item.status}" aria-label="${item.status}">
        <span aria-hidden="true">${statusIcon(item.status)}</span>
        <span class="visually-hidden">${item.status}</span>
      </span>
      <span class="checklist-text${item.status === "done" ? " done" : ""}">${esc(item.text)}</span>
      ${
        item.command
          ? `<button class="copy-btn" onclick="copyToClipboard('${esc(item.command)}', event)" aria-label="Copy ${esc(item.command)} to clipboard">${esc(item.command)}</button>`
          : ""
      }
    </li>`,
    )
    .join("\n");

  return `<ul class="checklist">${rows}</ul>`;
}
