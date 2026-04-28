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
  spec: { icon: "📝", label: "Specs", color: "accent" },
  plan: { icon: "📋", label: "Plans", color: "accent" },
  milestone: { icon: "🎯", label: "Milestones", color: "green" },
  "quick-work": { icon: "⚡", label: "Quick Work", color: "yellow" },
  debug: { icon: "🐛", label: "Debug", color: "red" },
  fix: { icon: "🔧", label: "Fixes", color: "green" },
  chore: { icon: "🧹", label: "Chores", color: "yellow" },
  review: { icon: "👁", label: "Reviews", color: "accent" },
};

/** Render status badge */
function statusBadge(status: string): string {
  const labels: Record<string, string> = {
    done: "✓ Done",
    "in-progress": "◐ In Progress",
    todo: "○ To Do",
    reviewed: "◉ Reviewed",
  };
  return `<span class="badge badge-${status}">${labels[status] ?? status}</span>`;
}

/** Render a single doc card */
function renderDocCard(doc: ParsedDoc): string {
  const config = DOC_TYPE_CONFIG[doc.type] ?? { icon: "📄", label: doc.type, color: "accent" };
  const total = doc.items.length;
  const done = doc.items.filter((i) => i.status === "done" || i.status === "reviewed").length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  const itemsHtml = doc.items
    .map(
      (item) => `
    <li class="checklist-item" style="display: none;" data-status="${item.status}">
      <span class="checklist-status ${item.status}">${
        item.status === "done" ? "✓" : item.status === "in-progress" ? "◐" : item.status === "reviewed" ? "◉" : "○"
      }</span>
      <span class="checklist-text${item.status === "done" || item.status === "reviewed" ? " done" : ""}">${esc(item.text)}</span>
      ${
        item.command
          ? `<button class="copy-btn" onclick="copyToClipboard('${esc(item.command)}', event)">📋</button>`
          : ""
      }
    </li>`,
    )
    .join("\n");

  return `
    <div class="card" x-data="{ open: false }">
      <div class="card-header" @click="open = !open" style="cursor: pointer;">
        <div>
          <span>${config.icon}</span>
          <span class="card-title">${esc(doc.title)}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${statusBadge(total === 0 ? (doc.type === "quick-work" ? "done" : "todo") : done === total ? "done" : "in-progress")}
          ${total > 0 ? `<span class="progress-text">${done}/${total}</span>` : ""}
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${percent}%"></div>
      </div>
      <template x-if="open">
        <ul class="checklist" style="margin-top: 0.5rem;">
          ${itemsHtml}
        </ul>
      </template>
      ${doc.warnings.length > 0 ? `<div class="warnings">${doc.warnings.map((w) => `<div class="warning-item">${esc(w)}</div>`).join("")}</div>` : ""}
    </div>`;
}

/** Render the workflow page */
export function renderWorkflowPage(docs: ParsedDoc[]): string {
  // Group by type
  const groups: Record<string, ParsedDoc[]> = {};
  for (const doc of docs) {
    if (!groups[doc.type]) groups[doc.type] = [];
    groups[doc.type].push(doc);
  }

  // Stats
  const totalDocs = docs.length;
  const totalItems = docs.reduce((sum, d) => sum + d.items.length, 0);
  const totalDone = docs.reduce(
    (sum, d) => sum + d.items.filter((i) => i.status === "done" || i.status === "reviewed").length,
    0,
  );

  let sectionsHtml = "";
  for (const [type, typeDocs] of Object.entries(groups)) {
    const config = DOC_TYPE_CONFIG[type as DocType] ?? {
      icon: "📄",
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
        <div class="section-header open" onclick="toggleSection(event)">
          <span class="section-toggle">▶</span>
          <span class="section-title">${config.icon} ${config.label}</span>
          <span class="section-count">${typeDocs.length} docs · ${typeDone}/${typeItems} items</span>
        </div>
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
        <div class="empty-state-icon">📋</div>
        <p class="empty-state-text">No workflow documents found</p>
      </div>`;
  }

  const content = `
    <div class="page-header">
      <h1 class="page-title">⚡ Workflow</h1>
      <p class="page-subtitle">${totalDocs} documents · ${totalDone}/${totalItems} items complete</p>
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
