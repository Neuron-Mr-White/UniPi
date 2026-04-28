/**
 * @pi-unipi/kanboard — Milestone Page
 *
 * Renders the milestone page with phases, progress bars, and checklists.
 */

import type { ParsedDoc, ParsedItem } from "../../types.js";
import { renderLayout } from "../layouts/base.js";

/** Escape HTML special characters */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render status icon for an item */
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

/** Render a single checklist item */
function renderItem(item: ParsedItem): string {
  const doneClass = item.status === "done" ? " done" : "";
  const commandBtn = item.command
    ? `<button class="copy-btn" onclick="copyToClipboard('${esc(item.command)}', event)" aria-label="Copy ${esc(item.command)} to clipboard">${esc(item.command)}</button>`
    : "";

  return `
    <li class="checklist-item">
      <span class="checklist-status ${item.status}" aria-label="${item.status}">
        <span aria-hidden="true">${statusIcon(item.status)}</span>
        <span class="visually-hidden">${item.status}</span>
      </span>
      <span class="checklist-text${doneClass}">${esc(item.text)}</span>
      ${commandBtn}
    </li>`;
}

/** Render the milestone page */
export function renderMilestonePage(docs: ParsedDoc[]): string {
  if (docs.length === 0) {
    const content = `
      <div class="page-header">
        <h1 class="page-title">Milestones</h1>
        <p class="page-subtitle">Track project progress</p>
      </div>
      <div class="empty-state">
        <div class="empty-state-icon">✦</div>
        <p class="empty-state-text">No MILESTONES.md found</p>
      </div>`;
    return renderLayout("Milestones", content, "milestones");
  }

  const doc = docs[0];
  const totalItems = doc.items.length;
  const doneItems = doc.items.filter((i) => i.status === "done").length;
  const percent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  const phases = groupByPhase(doc.items);

  let phasesHtml = "";
  for (const [phase, items] of Object.entries(phases)) {
    const phaseTotal = items.length;
    const phaseDone = items.filter((i) => i.status === "done").length;
    const phasePercent = phaseTotal > 0 ? Math.round((phaseDone / phaseTotal) * 100) : 0;

    phasesHtml += `
      <div class="section">
        <button type="button" class="section-header" aria-expanded="true" onclick="toggleSection(event)">
          <span class="section-toggle">▶</span>
          <div class="section-title-wrap">
            <h2 class="section-title">${esc(phase)}</h2>
          </div>
          <span class="section-count">${phaseDone}/${phaseTotal}</span>
          <div class="progress-bar" style="--progress: ${phasePercent};">
            <div class="progress-fill"></div>
          </div>
        </button>
        <div class="section-content">
          <ul class="checklist">
            ${items.map(renderItem).join("\n")}
          </ul>
        </div>
      </div>`;
  }

  const content = `
    <div class="page-header">
      <h1 class="page-title">${esc(doc.title)}</h1>
      <p class="page-subtitle">${doneItems}/${totalItems} items complete</p>
      <div class="progress-bar" style="--progress: ${percent};">
        <div class="progress-fill"></div>
      </div>
      <div class="page-header-stat">${percent}% complete</div>
    </div>

    ${phasesHtml}

    ${doc.warnings.length > 0 ? renderWarnings(doc.warnings) : ""}`;

  return renderLayout("Milestones", content, "milestones");
}

/** Group items by their phase prefix [Phase Name] */
function groupByPhase(items: ParsedItem[]): Record<string, ParsedItem[]> {
  const phases: Record<string, ParsedItem[]> = {};

  for (const item of items) {
    const match = item.text.match(/^\[(.+?)\]\s*(.*)$/);
    if (match) {
      const phase = match[1];
      const text = match[2];
      if (!phases[phase]) phases[phase] = [];
      phases[phase].push({ ...item, text });
    } else {
      if (!phases["Other"]) phases["Other"] = [];
      phases["Other"].push(item);
    }
  }

  return phases;
}

/** Render warnings list */
function renderWarnings(warnings: string[]): string {
  return `
    <div class="warnings">
      ${warnings.map((w) => `<div class="warning-item">${esc(w)}</div>`).join("\n")}
    </div>`;
}
