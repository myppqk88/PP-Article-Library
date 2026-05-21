/* ============================================================
 * 文献工作台 — Phase 4: wiki links [[paper_id]] + note split-preview.
 *
 * PDF outline sidebar is NOT included: it requires replacing the
 * iframe-based PDF viewer with pdf.js, which is a separate project.
 *
 * Wiki links: any `[[<paper_id>]]` or `[[<title_substring>]]` in the
 * note preview renders as a clickable chip; click → load that paper.
 *
 * Split preview: a third button in the seg toggles "分屏" — editor on
 * left, live preview on right, updating as you type.
 * ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // 1. Wiki link rendering
  // ============================================================
  let paperIndex = []; // [{paper_id, title_en, title_zh}]
  let paperFetched = 0;

  async function ensurePaperIndex() {
    if (paperIndex.length && Date.now() - paperFetched < 60_000) return;
    try {
      const resp = await fetch("/api/papers");
      if (!resp.ok) return;
      const data = await resp.json();
      paperIndex = (data.papers || []).map((p) => ({
        paper_id: p.paper_id,
        title_en: p.title_en || p.title || "",
        title_zh: p.title_zh || p["中文标题"] || "",
      }));
      paperFetched = Date.now();
    } catch (_) {}
  }

  function findPaperByRef(ref) {
    if (!ref) return null;
    const r = ref.trim().toLowerCase();
    // exact paper_id
    let m = paperIndex.find((p) => p.paper_id.toLowerCase() === r);
    if (m) return m;
    // prefix paper_id
    m = paperIndex.find((p) => p.paper_id.toLowerCase().startsWith(r));
    if (m) return m;
    // substring of title
    m = paperIndex.find(
      (p) =>
        (p.title_en || "").toLowerCase().includes(r) ||
        (p.title_zh || "").toLowerCase().includes(r)
    );
    return m || null;
  }

  function transformWikiLinks(root) {
    if (!root) return;
    // Walk text nodes, replace [[xxx]] with chip <a>
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest("code, pre, a")) continue;
      if (/\[\[[^\]]+\]\]/.test(n.nodeValue)) targets.push(n);
    }
    for (const tn of targets) {
      const text = tn.nodeValue;
      const frag = document.createDocumentFragment();
      let lastEnd = 0;
      const re = /\[\[([^\]]+)\]\]/g;
      let mm;
      while ((mm = re.exec(text)) !== null) {
        if (mm.index > lastEnd) {
          frag.appendChild(document.createTextNode(text.slice(lastEnd, mm.index)));
        }
        const ref = mm[1].trim();
        const found = findPaperByRef(ref);
        const a = document.createElement("a");
        a.className = "wiki-link" + (found ? "" : " wiki-broken");
        a.dataset.ref = ref;
        if (found) a.dataset.paperId = found.paper_id;
        a.textContent = found
          ? (found.title_zh || found.title_en || found.paper_id).slice(0, 40)
          : `[[${ref}]]`;
        a.title = found
          ? `${found.paper_id} — ${found.title_en || ""}`
          : `找不到匹配文献：${ref}`;
        frag.appendChild(a);
        lastEnd = mm.index + mm[0].length;
      }
      if (lastEnd < text.length) {
        frag.appendChild(document.createTextNode(text.slice(lastEnd)));
      }
      tn.parentNode.replaceChild(frag, tn);
    }
  }

  // Observe note preview for re-renders by app.js, then run wiki transform
  function installNotePreviewObserver() {
    const np = document.getElementById("notePreview");
    if (!np) return;
    let lastTransform = 0;
    const obs = new MutationObserver(() => {
      if (Date.now() - lastTransform < 80) return;
      // Skip if our transform is what just mutated
      if (np.dataset.wikiTransforming === "1") return;
      np.dataset.wikiTransforming = "1";
      ensurePaperIndex().then(() => {
        transformWikiLinks(np);
        np.dataset.wikiTransforming = "";
        lastTransform = Date.now();
      });
    });
    obs.observe(np, { childList: true, subtree: true, characterData: true });
    // Initial pass
    ensurePaperIndex().then(() => transformWikiLinks(np));
  }

  // Wiki-link click: navigate to that paper via the same search-and-click trick
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.wiki-link");
    if (!a) return;
    e.preventDefault();
    if (a.classList.contains("wiki-broken")) return;
    const paperId = a.dataset.paperId;
    if (!paperId) return;
    openPaperById(paperId);
  });

  function openPaperById(paperId) {
    const p = paperIndex.find((x) => x.paper_id === paperId);
    const titleHead = (p?.title_en || p?.title_zh || paperId).slice(0, 30);

    // Clear filters
    ["categorySelect", "readStatusFilter", "importanceFilter"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value) {
        el.value = "";
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    const searchInput = document.getElementById("searchInput");
    if (searchInput) {
      searchInput.value = titleHead;
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setTimeout(() => {
      const list = document.getElementById("paperList");
      if (!list) return;
      const items = list.querySelectorAll(".paper-item, .paper-card");
      for (const item of items) {
        const t = item.querySelector(".paper-title")?.textContent || "";
        if (t && (t.includes(titleHead) || titleHead.includes(t.slice(0, 24)))) {
          item.click();
          item.scrollIntoView({ block: "center" });
          return;
        }
      }
      const first = items[0];
      if (first) first.click();
    }, 220);
  }

  // ============================================================
  // 2. Note split-preview mode
  // ============================================================
  const NOTE_VIEW_KEY = "lit-hub-note-view"; // "preview" | "edit" | "split"

  function injectSplitSegment() {
    // Add a 3rd button "分屏" into the seg in note panel
    const seg = document.querySelector("#notePanel .seg");
    if (!seg) return;
    if (seg.querySelector('[data-mode="split"]')) return;
    const splitBtn = document.createElement("button");
    splitBtn.type = "button";
    splitBtn.dataset.mode = "split";
    splitBtn.textContent = "分屏";
    seg.appendChild(splitBtn);

    // Annotate the existing buttons too
    const previewBtn = seg.querySelector("#previewBtn");
    const editBtn = seg.querySelector("#editBtn");
    if (previewBtn) previewBtn.dataset.mode = "preview";
    if (editBtn) editBtn.dataset.mode = "edit";

    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (!b) return;
      const mode = b.dataset.mode;
      // Let app-phase1.js handle preview/edit clicks; we only step in for split
      if (mode === "split") {
        e.stopImmediatePropagation();
        applyNoteSplit(true);
      } else {
        applyNoteSplit(false);
      }
    });

    // restore saved
    const saved = (() => {
      try { return localStorage.getItem(NOTE_VIEW_KEY); } catch (_) { return null; }
    })();
    if (saved === "split") applyNoteSplit(true);
  }

  function applyNoteSplit(on) {
    const notePanel = document.getElementById("notePanel");
    const noteEditor = document.getElementById("noteEditor");
    const notePreview = document.getElementById("notePreview");
    if (!notePanel || !noteEditor || !notePreview) return;

    if (on) {
      notePanel.classList.add("note-split");
      // Build/ensure split host
      let host = notePanel.querySelector(".note-split-host");
      if (!host) {
        host = document.createElement("div");
        host.className = "note-split-host";
        notePanel.appendChild(host);
      }
      // Move editor and preview inside host
      if (noteEditor.parentElement !== host) host.appendChild(noteEditor);
      if (notePreview.parentElement !== host) host.appendChild(notePreview);
      noteEditor.classList.remove("hidden");
      notePreview.classList.remove("hidden");
      // live preview as user types
      if (!noteEditor.dataset.splitWired) {
        noteEditor.addEventListener("input", livePreview);
        noteEditor.dataset.splitWired = "1";
      }
      livePreview();
      try { localStorage.setItem(NOTE_VIEW_KEY, "split"); } catch (_) {}
      // mark our seg button active
      document
        .querySelectorAll('#notePanel .seg button[data-mode]')
        .forEach((b) => b.classList.toggle("active", b.dataset.mode === "split"));
    } else {
      notePanel.classList.remove("note-split");
      const host = notePanel.querySelector(".note-split-host");
      if (host) {
        // Move editor & preview back as direct children
        notePanel.insertBefore(noteEditor, host);
        notePanel.insertBefore(notePreview, host);
        host.remove();
      }
      // 清掉 split 按钮的 .active，避免多个按钮同时亮
      document
        .querySelectorAll('#notePanel .seg button[data-mode="split"]')
        .forEach((b) => b.classList.remove("active"));
      try {
        const cur = noteEditor.classList.contains("hidden") ? "preview" : "edit";
        localStorage.setItem(NOTE_VIEW_KEY, cur);
      } catch (_) {}
    }
  }

  function livePreview() {
    const noteEditor = document.getElementById("noteEditor");
    const notePreview = document.getElementById("notePreview");
    if (!noteEditor || !notePreview) return;
    if (!document.getElementById("notePanel").classList.contains("note-split")) return;
    const text = noteEditor.value || "";
    notePreview.innerHTML = simpleMarkdown(text);
    // Trigger wiki-link transform on next tick
    ensurePaperIndex().then(() => transformWikiLinks(notePreview));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])
    );
  }

  function simpleMarkdown(text) {
    const safe = escapeHtml(text);
    return safe
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+?)\*/g, "<em>$1</em>")
      .replace(/\n\n+/g, "</p><p>")
      .replace(/^/, "<p>")
      .replace(/$/, "</p>");
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    installNotePreviewObserver();
    injectSplitSegment();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
