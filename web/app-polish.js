/* ============================================================
 * 文献工作台 — Polish patches.
 *
 * - Toast helper: replaces alert() for non-critical notifications.
 * - Read-status segmented: click active button to clear status.
 * - Importance stars: hover preview.
 * - Sidebar paper-item title attribute set for tooltip on hover.
 * - PDF iframe page jump UX: ensure src includes #page=N consistently.
 * ============================================================ */

(function () {
  "use strict";

  // ============ Toast ============
  function ensureToastHost() {
    let host = document.getElementById("toastHost");
    if (host) return host;
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    document.body.appendChild(host);
    return host;
  }
  function toast(msg, kind) {
    const host = ensureToastHost();
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, kind === "error" ? 4500 : 2500);
  }
  // Expose globally so any phase script (or you) can call window.toast(...)
  window.toast = toast;

  // ============ Read-status seg clear ============
  document.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest("#readStatusSeg button");
      if (!b) return;
      // If the clicked button is already active, clear status.
      if (!b.classList.contains("active")) return;
      const select = document.getElementById("readStatus");
      if (!select) return;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      b.classList.remove("active");
      e.stopImmediatePropagation();
    },
    { capture: true }
  );

  // ============ Importance stars hover preview ============
  let starHoverHandlerInstalled = false;
  function installStarHover() {
    if (starHoverHandlerInstalled) return;
    const host = document.getElementById("importanceStars");
    if (!host) return;
    starHoverHandlerInstalled = true;
    host.addEventListener("mousemove", (e) => {
      const star = e.target.closest(".star");
      if (!star) return;
      const v = parseInt(star.dataset.value, 10) || 0;
      host.querySelectorAll(".star").forEach((s) => {
        const sv = parseInt(s.dataset.value, 10) || 0;
        s.classList.toggle("hover-on", sv <= v);
      });
    });
    host.addEventListener("mouseleave", () => {
      host.querySelectorAll(".star").forEach((s) => s.classList.remove("hover-on"));
    });
    // Add hover-on style via inline rule (so we don't need styles.css edits)
    const style = document.createElement("style");
    style.textContent = `
      #importanceStars .star.hover-on:not(.on) { color: var(--accent-soft); }
    `;
    document.head.appendChild(style);
  }
  // Try install periodically until present
  const installInterval = setInterval(() => {
    if (document.getElementById("importanceStars")) {
      installStarHover();
      clearInterval(installInterval);
    }
  }, 400);

  // ============ Sidebar title tooltip ============
  // Observe paper list; whenever rendered, set title="" on paper items
  function titleAllPaperItems() {
    document.querySelectorAll("#paperList .paper-item, #paperList .paper-card").forEach((item) => {
      const t = item.querySelector(".paper-title")?.textContent || "";
      const zh = item.querySelector(".paper-title-zh, .paper-zh")?.textContent || "";
      const sub = item.querySelector(".paper-sub, .paper-venue")?.textContent || "";
      if (t) item.title = [t, zh, sub].filter(Boolean).join(" — ");
    });
  }
  const paperList = document.getElementById("paperList");
  if (paperList) {
    const obs = new MutationObserver(() => {
      // Throttle
      if (paperList.dataset.titledAt && Date.now() - parseInt(paperList.dataset.titledAt, 10) < 200)
        return;
      titleAllPaperItems();
      paperList.dataset.titledAt = String(Date.now());
    });
    obs.observe(paperList, { childList: true });
    titleAllPaperItems();
  }

  // ============ Reroute some alerts to toast where benign ============
  // We can't easily intercept alert() globally for app.js, but we hint by
  // exposing window.toast for any new code. (app-phase3.js uses alert for
  // bulk operation results — those are intentionally blocking.)

  // ============ Conversation chip double-click to rename ============
  document.addEventListener(
    "dblclick",
    (e) => {
      const chip = e.target.closest(".conv-chip");
      if (!chip) return;
      const name = chip.querySelector(".conv-name");
      if (!name) return;
      // Forward to existing rename flow via the ⋮ menu prompt
      const menuBtn = chip.querySelector(".conv-menu");
      if (menuBtn) {
        menuBtn.click();
      }
    },
    { capture: true }
  );
})();
