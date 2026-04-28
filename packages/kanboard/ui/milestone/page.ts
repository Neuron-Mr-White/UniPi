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
      return '<span class="checklist-status done">✓</span>';
    case "in-progress":
      return '<span class="checklist-status in-progress">◐</span>';
    default:
      return '<span class="checklist-status todo">○</span>';
  }
}

/** Render a single checklist item */
function renderItem(item: ParsedItem): string {
  const doneClass = item.status === "done" ? " done" : "";
  const commandBtn = item.command
    ? `<button class="copy-btn" onclick="copyToClipboard('${esc(item.command)}', event)">📋 ${esc(item.command)}</button>`
    : "";

  return `
    <li class="checklist-item">
      ${statusIcon(item.status)}
      <span class="checklist-text${doneClass}">${esc(item.text)}</span>
      ${commandBtn}
    </li>`;
}

/** Render the milestone page */
export function renderMilestonePage(docs: ParsedDoc[]): string {
  if (docs.length === 0) {
    const content = `
      <div class="page-header">
        <h1 class="page-title">🎯 Milestones</h1>
        <p class="page-subtitle">Track project progress</p>
      </div>
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <p class="empty-state-text">No MILESTONES.md found</p>
      </div>`;
    return renderLayout("Milestones", content, "milestones");
  }

  const doc = docs[0]; // Primary milestones doc
  const totalItems = doc.items.length;
  const doneItems = doc.items.filter((i) => i.status === "done").length;
  const percent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;

  // Group items by phase (items prefixed with [Phase Name])
  const phases = groupByPhase(doc.items);

  let phasesHtml = "";
  for (const [phase, items] of Object.entries(phases)) {
    const phaseTotal = items.length;
    const phaseDone = items.filter((i) => i.status === "done").length;
    const phasePercent =
      phaseTotal > 0 ? Math.round((phaseDone / phaseTotal) * 100) : 0;

    phasesHtml += `
      <div class="section">
        <div class="section-header open" onclick="toggleSection(event)">
          <span class="section-toggle">▶</span>
          <span class="section-title">${esc(phase)}</span>
          <span class="section-count">${phaseDone}/${phaseTotal}</span>
          <div class="progress-bar" style="width: 120px;">
            <div class="progress-fill" style="width: ${phasePercent}%"></div>
          </div>
        </div>
        <div class="section-content">
          <ul class="checklist">
            ${items.map(renderItem).join("\n")}
          </ul>
        </div>
      </div>`;
  }

  const content = `
    <div class="page-header">
      <h1 class="page-title">🎯 ${esc(doc.title)}</h1>
      <p class="page-subtitle">${doneItems}/${totalItems} items complete (${percent}%)</p>
      <div class="progress-bar" style="margin-top: 0.5rem;">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
    </div>

    ${phasesHtml}

    ${doc.warnings.length > 0 ? renderWarnings(doc.warnings) : ""}`;

  return renderLayout("Milestones", content, "milestones");
}

/** Group items by their phase prefix [Phase Name] */
function groupByPhase(
  items: ParsedItem[],
): Record<string, ParsedItem[]> {
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
