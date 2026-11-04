(() => {
  "use strict";
  // Sidebar groups of the .NET console: same behavior legacy-navigation.js gives the original panel's sidebar.
  // Collapsed by default, a click on the group toggles it, and the group of the current page opens by itself until
  // the user chooses otherwise. In the icon rail the label is hidden and the click keeps navigating.
  const choice = new Map();
  function sync() {
    for (const parent of document.querySelectorAll(".app-nav a.nav-parent")) {
      const list = parent.nextElementSibling;
      if (!list?.classList.contains("nav-submenu")) continue;
      const key = parent.getAttribute("href");
      const current = [...list.querySelectorAll("a[href]")].some((link) => link.pathname === window.location.pathname);
      const open = choice.has(key) ? choice.get(key) : current;
      parent.toggleAttribute("data-open", open);
      parent.setAttribute("aria-expanded", String(open));
    }
  }
  document.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const parent = event.target.closest?.(".app-nav a.nav-parent");
    const label = parent?.querySelector("span");
    if (!label || getComputedStyle(label).display === "none") return;
    // Capture phase: runs before Blazor's enhanced navigation handler.
    event.preventDefault();
    event.stopPropagation();
    choice.set(parent.getAttribute("href"), parent.getAttribute("aria-expanded") !== "true");
    sync();
  }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync, { once: true });
  else sync();
  // Enhanced navigation patches the sidebar back to the server's markup; reapply the open groups afterwards.
  window.addEventListener("load", () => { window.Blazor?.addEventListener?.("enhancedload", sync); sync(); }, { once: true });
})();
