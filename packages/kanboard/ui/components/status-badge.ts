/**
 * @pi-unipi/kanboard — Status Badge Component
 *
 * Color-coded status badge for items.
 */

/** Status badge labels */
const BADGE_LABELS: Record<string, string> = {
  done: "✓ Done",
  "in-progress": "◐ In Progress",
  todo: "○ To Do",
};

/**
 * Render a status badge.
 */
export function renderStatusBadge(status: string): string {
  const label = BADGE_LABELS[status] ?? status;
  return `<span class="badge badge-${status}">${label}</span>`;
}
