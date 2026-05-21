/* ============================================================
 * 文献工作台 — Phase 1 additive UI patches.
 *
 * This file is loaded AFTER app.js as a second module. It does NOT
 * touch existing behavior; it only adds the new visual controls
 * (theme picker, overflow menu, stars, segmented status, sticky color
 * picker, edit/preview segmented label sync, "/" search shortcut).
 *
 * Safe to remove or replace — your existing app.js continues to work
 * with the original elements; this file just synchronizes the new
 * visual controls back to those existing form fields.
 * ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // 1. Theme switching
  // ============================================================
  const THEME_KEY = "lit-hub-theme";
  const VALID_THEMES = ["clay", "mono", "forest", "ocean"];

  function applyTheme(theme) {
    if (!VALID_THEMES.includes(theme)) theme = "clay";
    document.body.classList.remove(
      "theme-clay",
      "theme-mono",
      "theme-forest",
      "theme-ocean"
    );
    if (theme !== "clay") document.body.classList.add("theme-" + theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (_) {}
    document
      .querySelectorAll("#themePicker button[data-theme]")
      .forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
  }

  const savedTheme = (function () {
    try {
      return localStorage.getItem(THEME_KEY) || "clay";
    } catch (_) {
      return "clay";
    }
  })();
  applyTheme(savedTheme);

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#themePicker button[data-theme]");
    if (btn) applyTheme(btn.dataset.theme);
  });

  // ============================================================
  // 2. Overflow menu (top-bar "⋯")
  // ============================================================
  const overflowBtn = document.getElementById("overflowBtn");
  const overflowMenu = document.getElementById("overflowMenu");
  if (overflowBtn && overflowMenu) {
    overflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      overflowMenu.classList.toggle("show");
    });
    document.addEventListener("click", (e) => {
      if (
        !overflowMenu.contains(e.target) &&
        !overflowBtn.contains(e.target)
      ) {
        overflowMenu.classList.remove("show");
      }
    });
    // Hide menu shortly after any item is clicked
    overflowMenu.addEventListener("click", (e) => {
      if (e.target.closest("button, a")) {
        setTimeout(() => overflowMenu.classList.remove("show"), 80);
      }
    });
  }

  // ============================================================
  // 3. Importance: star control synced with <select id="importance">
  // ============================================================
  function syncImportanceStars() {
    const select = document.getElementById("importance");
    const stars = document.getElementById("importanceStars");
    if (!select || !stars) return;
    const value = parseInt(select.value, 10) || 0;
    stars.querySelectorAll(".star").forEach((s) => {
      const v = parseInt(s.dataset.value, 10);
      s.classList.toggle("on", v <= value);
    });
    const meta = document.getElementById("importanceStarsMeta");
    if (meta) meta.textContent = value > 0 ? value + "/5" : "未定";
  }

  document.addEventListener("click", (e) => {
    const star = e.target.closest("#importanceStars .star");
    if (!star) return;
    const select = document.getElementById("importance");
    if (!select) return;
    const newValue = star.dataset.value;
    // Click on the currently-highest star clears the rating
    select.value = select.value === newValue ? "" : newValue;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncImportanceStars();
  });

  // ============================================================
  // 4. Read status: segmented control synced with <select id="readStatus">
  // ============================================================
  function syncReadStatusSeg() {
    const select = document.getElementById("readStatus");
    const seg = document.getElementById("readStatusSeg");
    if (!select || !seg) return;
    const value = select.value;
    seg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.value === value);
    });
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("#readStatusSeg button");
    if (!b) return;
    const select = document.getElementById("readStatus");
    if (!select) return;
    select.value = select.value === b.dataset.value ? "" : b.dataset.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncReadStatusSeg();
  });

  // ============================================================
  // 5. Light polling to keep stars/segmented in sync with app.js writes
  //    (app.js sets select.value when a paper is selected, without
  //     firing a change event). 700 ms is imperceptible to the user.
  // ============================================================
  setInterval(() => {
    syncImportanceStars();
    syncReadStatusSeg();
    syncFilterPills();
  }, 700);

  // ============================================================
  // 6. Sticky color picker — exposes selected color on the add button
  //    via data-color="<clay|yellow|green|blue|pink>". app.js will pick
  //    this up in Phase 2 (or you can read it now if you wire it).
  // ============================================================
  const stickyColorRow = document.getElementById("stickyColorRow");
  const stickyAddBtn = document.getElementById("stickyAddBtn");
  if (stickyColorRow && stickyAddBtn) {
    if (!stickyAddBtn.dataset.color) stickyAddBtn.dataset.color = "clay";
    stickyColorRow.addEventListener("click", (e) => {
      const dot = e.target.closest(".color-dot");
      if (!dot) return;
      stickyColorRow
        .querySelectorAll(".color-dot")
        .forEach((d) => d.classList.remove("active"));
      dot.classList.add("active");
      stickyAddBtn.dataset.color = dot.dataset.color;
    });
  }

  // ============================================================
  // 7. Note-panel "预览 / 编辑" segmented control
  //    The original app.js binds a click handler to #previewBtn that
  //    toggles between modes and overwrites its text. We:
  //      a) Keep a MutationObserver that resets the static label.
  //      b) Sync .active class on both buttons whenever noteEditor's
  //         hidden state changes.
  //      c) Make #editBtn forward to #previewBtn only when needed.
  //      d) Make #previewBtn no-op when already in preview mode.
  // ============================================================
  function syncEditPreviewSeg() {
    const noteEditor = document.getElementById("noteEditor");
    const previewBtn = document.getElementById("previewBtn");
    const editBtn = document.getElementById("editBtn");
    if (!noteEditor || !previewBtn || !editBtn) return;
    const inPreview = noteEditor.classList.contains("hidden");
    previewBtn.classList.toggle("active", inPreview);
    editBtn.classList.toggle("active", !inPreview);
  }

  const previewBtn = document.getElementById("previewBtn");
  const editBtn = document.getElementById("editBtn");
  const noteEditor = document.getElementById("noteEditor");

  if (previewBtn) {
    // Capture-phase intercept: prevent toggle when already in target mode
    previewBtn.addEventListener(
      "click",
      (e) => {
        const ne = document.getElementById("noteEditor");
        if (ne && ne.classList.contains("hidden")) {
          // already in preview mode — don't let the original handler toggle
          e.stopImmediatePropagation();
        }
        // Re-sync shortly after (regardless of whether we blocked or not)
        setTimeout(syncEditPreviewSeg, 60);
      },
      { capture: true }
    );

    // Keep the static label "预览" — app.js may overwrite textContent
    const labelObs = new MutationObserver(() => {
      if (previewBtn.textContent !== "预览") previewBtn.textContent = "预览";
    });
    labelObs.observe(previewBtn, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    previewBtn.textContent = "预览";
  }

  if (editBtn) {
    editBtn.addEventListener("click", () => {
      const ne = document.getElementById("noteEditor");
      const pb = document.getElementById("previewBtn");
      if (ne && pb && ne.classList.contains("hidden")) {
        // Currently in preview → fire the original toggle to enter edit mode
        pb.click();
      }
      setTimeout(syncEditPreviewSeg, 60);
    });
  }

  if (noteEditor) {
    new MutationObserver(syncEditPreviewSeg).observe(noteEditor, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  // ============================================================
  // 8. "/" shortcut focuses the search box
  // ============================================================
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.target.isContentEditable) return;
    e.preventDefault();
    const searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.focus();
  });

  // ============================================================
  // 9. Filter pills: highlight when a non-default value is selected
  // ============================================================
  function syncFilterPills() {
    document.querySelectorAll(".filter-stack select").forEach((s) => {
      const v = s.value || "";
      const isSortDefault = s.id === "sortSelect" && v === "added:desc";
      const isEmpty = v === "";
      s.classList.toggle("has-value", !isEmpty && !isSortDefault);
    });
  }
  document.querySelectorAll(".filter-stack select").forEach((s) => {
    s.addEventListener("change", syncFilterPills);
  });

  // ============================================================
  // 10. Initial syncs
  // ============================================================
  syncImportanceStars();
  syncReadStatusSeg();
  syncEditPreviewSeg();
  syncFilterPills();
})();
