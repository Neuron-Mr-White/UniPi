/* @pi-unipi/kanboard — Client-side JavaScript */

/**
 * Copy text to clipboard and show feedback.
 * Used by Alpine.js x-on:click handlers.
 */
function copyToClipboard(text, event) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.currentTarget;
    btn.classList.add("copied");
    const original = btn.innerHTML;
    btn.innerHTML = "✓ Copied!";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = original;
    }, 2000);
  });
}

/**
 * Toggle a section's expanded state.
 */
function toggleSection(event) {
  const header = event.currentTarget;
  const content = header.nextElementSibling;
  header.classList.toggle("open");
  if (content) {
    content.style.display = content.style.display === "none" ? "block" : "none";
  }
}

/**
 * Alpine.js data for filtering items by status.
 */
function kanboardFilters() {
  return {
    filter: "all",
    setFilter(f) {
      this.filter = f;
    },
    isVisible(status) {
      if (this.filter === "all") return true;
      return status === this.filter;
    },
  };
}
