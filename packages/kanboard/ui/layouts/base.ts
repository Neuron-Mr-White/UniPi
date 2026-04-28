/**
 * @pi-unipi/kanboard — Base HTML Layout
 *
 * Shared layout for all kanboard web pages.
 * Includes htmx + Alpine.js CDN, navigation, and responsive layout.
 */

/** Active page type */
export type ActivePage = "milestones" | "workflow";

/**
 * Render the full HTML layout wrapping page content.
 */
export function renderLayout(
  title: string,
  content: string,
  activePage: ActivePage,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Kanboard</title>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script defer src="https://unpkg.com/alpinejs@3.14.3/dist/cdn.min.js"></script>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <nav class="navbar">
    <div class="nav-brand">
      <span class="nav-icon">📋</span>
      <span class="nav-title">Kanboard</span>
    </div>
    <div class="nav-links">
      <a href="/" class="nav-link ${activePage === "milestones" ? "active" : ""}">
        🎯 Milestones
      </a>
      <a href="/workflow" class="nav-link ${activePage === "workflow" ? "active" : ""}">
        ⚡ Workflow
      </a>
    </div>
  </nav>

  <main class="container">
    ${content}
  </main>

  <footer class="footer">
    <span>Powered by <strong>@pi-unipi/kanboard</strong></span>
  </footer>

  <script src="/static/app.js"></script>
</body>
</html>`;
}

/** Escape HTML special characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
