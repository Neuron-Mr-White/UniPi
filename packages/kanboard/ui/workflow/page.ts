/**
 * @pi-unipi/kanboard — Workflow Page
 *
 * Renders the workflow page with cards grouped by doc type.
 */

import type { ParsedDoc, ParsedItem, DocType } from "../../types.js";
import { renderLayout } from "../layouts/base.js";

/** Escape HTML */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Doc type display config */
const DOC_TYPE_CONFIG: Record<
  DocType,
  { icon: string; label: string; color: string }
> = {
  spec: { icon: "◈", label: "Specs", color: "accent" },
  plan: { icon: "◈", label: "Plans", color: "accent" },
  milestone: { icon: "◉", label: "Milestones", color: "green" },
  "quick-work": { icon: "⚡", label: "Quick Work", color: "yellow" },
  debug: { icon: "◆", label: "Debug", color: "red" },
  fix: { icon: "◊", label: "Fixes", color: "green" },
  chore: { icon: "◇", label: "Chores", color: "yellow" },
  review: { icon: "◈", label: "Reviews", color: "accent" },
};

/** Render status badge */
function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    done: "Done",
    "in-progress": "In Progress",
    todo: "To Do",
    reviewed: "Reviewed",
  };
  return `<span class="badge badge-${status}">${labels[status] ?? status}</span>`;
}

/** Render status icon */
function statusIcon(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "in-progress":
      return "◐";
    case "reviewed":
      return "◉";
    default:
      return "○";
  }
}

/** Render a single doc card */
function renderDocCard(doc: ParsedDoc): string {
  const config = DOC_TYPE_CONFIG[doc.type] ?? { icon: "◈", label: doc.type, color: "accent" };
  const total = doc.items.length;
  const done = doc.items.filter((i) => i.status === "done" || i.status === "reviewed").length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const itemsHtml = doc.items
    .map(
      (item) => `
    <li class="checklist-item" data-status="${item.status}">
      <span class="checklist-status ${item.status}" aria-label="${item.status}">
        <span aria-hidden="true">${statusIcon(item.status)}</span>
        <span class="visually-hidden">${item.status}</span>
      </span>
      <span class="checklist-text${item.status === "done" || item.status === "reviewed" ? " done" : ""}">${esc(item.text)}</span>
      ${
        item.command
          ? `<button class="copy-btn" onclick="copyToClipboard('${esc(item.command)}', event)" aria-label="Copy ${esc(item.command)} to clipboard">${esc(item.command)}</button>`
          : ""
      }
    </li>`,
    )
    .join("\n");

  return `
    <div class="card" x-data="{ open: false }">
      <button type="button" class="card-header" @click="open = !open" :aria-expanded="open">
        <div class="card-header-inner">
          <span class="doc-type-icon">${config.icon}</span>
          <h3 class="card-title">${esc(doc.title)}</h3>
        </div>
        <div class="card-meta">
          ${statusBadge(total === 0 ? (doc.type === "quick-work" ? "done" : "todo") : done === total ? "done" : "in-progress")}
          ${total > 0 ? `<span class="progress-text">${done}/${total}</span>` : ""}
        </div>
      </button>
      <div class="progress-bar" style="--progress: ${percent};">
        <div class="progress-fill"></div>
      </div>
      <template x-if="open">
        <ul class="checklist">
          ${itemsHtml}
        </ul>
      </template>
      ${doc.warnings.length > 0
        ? `<div class="warnings">${doc.warnings.map((w) => `<div class="warning-item">${esc(w)}</div>`).join("")}</div>`
        : ""}
    </div>`;
}

/** Render the workflow page */
export function renderWorkflowPage(docs: ParsedDoc[]): string {
  const groups: Record<string, ParsedDoc[]> = {};
  for (const doc of docs) {
    if (!groups[doc.type]) groups[doc.type] = [];
    groups[doc.type].push(doc);
  }

  const totalDocs = docs.length;
  const totalItems = docs.reduce((sum, d) => sum + d.items.length, 0);
  const totalDone = docs.reduce(
    (sum, d) => sum + d.items.filter((i) => i.status === "done" || i.status === "reviewed").length,
    0,
  );

  let sectionsHtml = "";
  for (const [type, typeDocs] of Object.entries(groups)) {
    const config = DOC_TYPE_CONFIG[type as DocType] ?? {
      icon: "◈",
      label: type,
      color: "accent",
    };

    const typeItems = typeDocs.reduce((sum, d) => sum + d.items.length, 0);
    const typeDone = typeDocs.reduce(
      (sum, d) => sum + d.items.filter((i) => i.status === "done" || i.status === "reviewed").length,
      0,
    );

    sectionsHtml += `
      <div class="section">
        <button type="button" class="section-header" aria-expanded="true" onclick="toggleSection(event)">
          <span class="section-toggle">▶</span>
          <div class="section-title-wrap">
            <h2 class="section-title">${config.icon} ${config.label}</h2>
          </div>
          <span class="section-count">${typeDocs.length} docs · ${typeDone}/${typeItems} items</span>
        </button>
        <div class="section-content">
          <div class="card-grid">
            ${typeDocs.map(renderDocCard).join("\n")}
          </div>
        </div>
      </div>`;
  }

  if (totalDocs === 0) {
    sectionsHtml = `
      <div class="empty-state">
        <div class="empty-state-icon">✦</div>
        <p class="empty-state-text">No workflow documents found</p>
      </div>`;
  }

  const content = `
    <div class="page-header">
      <h1 class="page-title">Workflow</h1>
      <p class="page-subtitle">${totalDocs} documents · ${totalDone}/${totalItems} items complete</p>
      <div class="page-header-stat">${totalItems > 0 ? Math.round((totalDone / totalItems) * 100) : 0}% across all documents</div>
    </div>

    <div class="filters" x-data="kanboardFilters()">
      <button class="filter-btn" :class="{ active: filter === 'all' }" @click="setFilter('all')">All</button>
      <button class="filter-btn" :class="{ active: filter === 'todo' }" @click="setFilter('todo')">To Do</button>
      <button class="filter-btn" :class="{ active: filter === 'in-progress' }" @click="setFilter('in-progress')">In Progress</button>
      <button class="filter-btn" :class="{ active: filter === 'reviewed' }" @click="setFilter('reviewed')">Reviewed</button>
      <button class="filter-btn" :class="{ active: filter === 'done' }" @click="setFilter('done')">Done</button>
    </div>

    ${sectionsHtml}`;

  return renderLayout("Workflow", content, "workflow");
}
