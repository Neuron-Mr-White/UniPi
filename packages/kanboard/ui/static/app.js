/* @pi-unipi/kanboard — Client-side JavaScript */

/**
 * Copy text to clipboard and show feedback.
 */
function copyToClipboard(text, event) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.currentTarget;
    btn.classList.add("copied");
    const original = btn.innerHTML;
    btn.innerHTML = '<span>copied</span>';
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = original;
    }, 1800);
  });
}

/**
 * Toggle a section's expanded state with animation.
 */
function toggleSection(event) {
  const header = event.currentTarget;
  const content = header.nextElementSibling;
  if (!content) return;

  const wasOpen = header.getAttribute("aria-expanded") === "true";
  header.setAttribute("aria-expanded", wasOpen ? "false" : "true");

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!wasOpen) {
    content.style.display = "block";
    if (!prefersReducedMotion) {
      content.style.opacity = "0";
      content.style.transform = "translateY(-4px)";
      requestAnimationFrame(() => {
        content.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        content.style.opacity = "1";
        content.style.transform = "translateY(0)";
      });
    } else {
      content.style.opacity = "1";
      content.style.transform = "translateY(0)";
    }
  } else {
    if (!prefersReducedMotion) {
      content.style.transition = "opacity 0.15s ease";
      content.style.opacity = "0";
      setTimeout(() => {
        content.style.display = "none";
      }, 150);
    } else {
      content.style.display = "none";
    }
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
