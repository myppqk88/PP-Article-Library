/* ============================================================
 * 文献工作台 — Design patch: 便签 tab
 *
 * Replaces #annotPanel (legacy ID; serves as 便签 tab) with:
 *   ┌─ compose card ─────────────────────────┐
 *   │ 给本文献写一条便签… 支持 Markdown          │
 *   │                                          │
 *   │ ● ● ● ● ●  ⌘Enter        [添加便签 primary]│
 *   └────────────────────────────────────────┘
 *   [本文献·3] [全部·24]               ● ● ● ●  (color filter)
 *   ┌─ sticky cards with left vertical color stripe ─┐
 *
 * The existing app.js logic (addSticky / renderStickyList / etc.) is
 * preserved — this patch only rebuilds the SHELL and gives it a richer
 * 「全部」cross-paper view.
 * ============================================================ */

(function () {
  "use strict";

  // 5 color slots matching the design mockup
  const COLORS = ["brown", "amber", "red", "orange", "green"];

  // ============================================================
  // 1. Scoped styles
  // ============================================================
  function injectStyles() {
    if (document.getElementById("dc-sticky-style")) return;
    const s = document.createElement("style");
    s.id = "dc-sticky-style";
    s.textContent = `
      /* Hide legacy structure */
      #annotPanel > .panel-actions { display: none !important; }
      #annotPanel > .sticky-new { display: none !important; }
      #annotPanel > .sticky-empty { display: none !important; }

      #annotPanel { gap: 12px; }

      /* Compose card */
      .dc-sticky-compose {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-card);
        padding: 12px 14px 10px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        transition: border-color 0.12s, background 0.12s;
      }
      .dc-sticky-compose:focus-within {
        border-color: var(--dc-accent);
        background: var(--dc-surface);
      }
      .dc-sticky-textarea {
        border: none;
        background: transparent;
        outline: none;
        resize: none;
        min-height: 64px;
        font-family: var(--dc-font-sans);
        font-size: var(--dc-fs-body);
        line-height: 1.55;
        color: var(--dc-text);
        padding: 0;
        width: 100%;
      }
      .dc-sticky-textarea::placeholder { color: var(--dc-muted-soft); }

      .dc-sticky-compose-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dc-sticky-colordots {
        display: inline-flex;
        gap: 6px;
        align-items: center;
      }
      .dc-sticky-dot {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        cursor: pointer;
        border: 2px solid transparent;
        transition: transform 0.1s, border-color 0.1s, box-shadow 0.1s;
      }
      .dc-sticky-dot.active {
        border-color: var(--dc-text-strong);
        transform: scale(1.12);
        box-shadow: 0 0 0 2px var(--dc-surface) inset;
      }
      .dc-sticky-dot[data-c="brown"]  { background: var(--dc-sticky-brown-bar); }
      .dc-sticky-dot[data-c="amber"]  { background: var(--dc-sticky-amber-dot); }
      .dc-sticky-dot[data-c="red"]    { background: var(--dc-sticky-red-dot); }
      .dc-sticky-dot[data-c="orange"] { background: var(--dc-sticky-orange-dot); }
      .dc-sticky-dot[data-c="green"]  { background: var(--dc-sticky-green-dot); }
      .dc-sticky-spacer { flex: 1; }
      .dc-sticky-kbd {
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted-soft);
        padding: 2px 6px;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-input);
        background: var(--dc-surface);
        font-family: var(--dc-font-mono);
      }
      .dc-sticky-submit {
        background: var(--dc-accent);
        color: var(--dc-accent-ink);
        border: 1px solid var(--dc-accent);
        border-radius: var(--dc-r-button);
        padding: 6px 14px;
        font-size: var(--dc-fs-body);
        font-weight: var(--dc-fw-medium);
        cursor: pointer;
      }
      .dc-sticky-submit:hover { background: var(--dc-accent-strong); border-color: var(--dc-accent-strong); }
      .dc-sticky-submit:disabled { opacity: 0.5; cursor: not-allowed; }

      /* Filter row */
      .dc-sticky-filter {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dc-sticky-filter .dc-sticky-colordots {
        margin-left: auto;
      }
      .dc-sticky-filter .dc-sticky-colordots .dc-sticky-dot {
        width: 14px;
        height: 14px;
        opacity: 0.5;
        cursor: pointer;
      }
      .dc-sticky-filter .dc-sticky-colordots .dc-sticky-dot.active {
        opacity: 1;
        transform: scale(1.15);
        border-color: var(--dc-accent);
      }

      /* Sticky list & cards */
      .dc-sticky-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .dc-sticky-empty {
        padding: 28px 16px;
        text-align: center;
        font-size: var(--dc-fs-sm);
        color: var(--dc-muted-soft);
        border: 1px dashed var(--dc-line);
        border-radius: var(--dc-r-card);
        background: var(--dc-panel-soft);
        line-height: 1.7;
      }
      .dc-sticky-card {
        position: relative;
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-card);
        padding: 11px 14px 10px 18px;
        transition: border-color 0.12s, box-shadow 0.12s;
      }
      .dc-sticky-card:hover {
        border-color: var(--dc-accent-soft);
        box-shadow: var(--dc-shadow-1);
      }
      .dc-sticky-card::before {
        content: "";
        position: absolute;
        left: 0;
        top: 10px;
        bottom: 10px;
        width: 3px;
        border-radius: 2px;
        background: var(--dc-muted-soft);
      }
      .dc-sticky-card[data-c="brown"]::before  { background: var(--dc-sticky-brown-bar); }
      .dc-sticky-card[data-c="amber"]::before,
      .dc-sticky-card[data-c="yellow"]::before { background: var(--dc-sticky-amber-bar); }
      .dc-sticky-card[data-c="red"]::before,
      .dc-sticky-card[data-c="pink"]::before   { background: var(--dc-sticky-red-bar); }
      .dc-sticky-card[data-c="orange"]::before,
      .dc-sticky-card[data-c="clay"]::before   { background: var(--dc-sticky-orange-bar); }
      .dc-sticky-card[data-c="green"]::before  { background: var(--dc-sticky-green-bar); }
      .dc-sticky-card[data-c="blue"]::before   { background: #6f9ad1; }
      .dc-sticky-content {
        font-size: var(--dc-fs-body);
        line-height: 1.55;
        color: var(--dc-text);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .dc-sticky-content code {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line-soft);
        padding: 1px 5px;
        border-radius: 3px;
        font-family: var(--dc-font-mono);
        font-size: 0.92em;
      }
      .dc-sticky-meta {
        margin-top: 8px;
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        flex-wrap: wrap;
      }
      .dc-sticky-meta .dc-sticky-paper {
        font-family: var(--dc-font-serif);
        color: var(--dc-muted);
      }
      .dc-sticky-meta .dc-sticky-actions {
        margin-left: auto;
        display: flex;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.12s;
      }
      .dc-sticky-card:hover .dc-sticky-meta .dc-sticky-actions { opacity: 1; }
      .dc-sticky-actions button {
        background: transparent;
        border: none;
        color: var(--dc-muted);
        font-size: var(--dc-fs-xs);
        padding: 2px 7px;
        border-radius: var(--dc-r-button);
        cursor: pointer;
      }
      .dc-sticky-actions button:hover {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
      }
      .dc-sticky-actions button.danger:hover {
        background: var(--dc-danger-soft);
        color: var(--dc-danger);
      }

      /* Editing in-place */
      .dc-sticky-card.editing {
        background: var(--dc-accent-tint);
        border-color: var(--dc-accent);
      }
      .dc-sticky-edit-textarea {
        width: 100%;
        min-height: 64px;
        padding: 6px 8px;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-input);
        background: var(--dc-surface);
        font-family: var(--dc-font-sans);
        font-size: var(--dc-fs-body);
        line-height: 1.55;
        resize: vertical;
      }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  // 2. State
  // ============================================================
  let state = {
    selectedColor: "orange", // for new sticky (orange = "clay" in legacy)
    scope: "paper",          // paper | all
    colorFilter: null,       // null = no filter, else color name
    stickies: [],            // either this-paper stickies or all
    paperId: "",
    stats: { paper: 0, total: 0, papers_with_stickies: 0 },
  };

  function getActivePaperId() {
    return window.__litHubCurrentPaperId || "";
  }

  // ============================================================
  // 3. Mount
  // ============================================================
  function mount() {
    const panel = document.getElementById("annotPanel");
    if (!panel) return false;
    if (panel.dataset.dcMounted) return true;
    panel.dataset.dcMounted = "1";

    // Compose card
    const compose = document.createElement("div");
    compose.className = "dc-sticky-compose";
    compose.id = "dcStickyCompose";
    compose.innerHTML = `
      <textarea class="dc-sticky-textarea" id="dcStickyInput"
        placeholder="给本文献写一条便签… 支持 Markdown、代码块、@跳页"
        spellcheck="false"></textarea>
      <div class="dc-sticky-compose-bar">
        <div class="dc-sticky-colordots" id="dcStickyColorPicker">
          ${COLORS.map(c => `<span class="dc-sticky-dot${c === state.selectedColor ? " active" : ""}" data-c="${c}" title="${c}"></span>`).join("")}
        </div>
        <span class="dc-sticky-kbd">⌘Enter</span>
        <span class="dc-sticky-spacer"></span>
        <button class="dc-sticky-submit" id="dcStickyAddBtn" type="button" disabled>添加便签</button>
      </div>
    `;

    // Filter row
    const filter = document.createElement("div");
    filter.className = "dc-sticky-filter";
    filter.id = "dcStickyFilter";
    filter.innerHTML = `
      <div class="dc-pill-tabs" id="dcStickyScopeTabs">
        <button class="active" data-scope="paper">本文献<span class="dc-pill-count" id="dcStickyScopePaperCount">0</span></button>
        <button data-scope="all">全部<span class="dc-pill-count" id="dcStickyScopeAllCount">0</span></button>
      </div>
      <div class="dc-sticky-colordots" id="dcStickyColorFilter">
        ${COLORS.map(c => `<span class="dc-sticky-dot" data-c="${c}" title="只看 ${c}"></span>`).join("")}
      </div>
    `;

    // List host
    const list = document.createElement("div");
    list.className = "dc-sticky-list";
    list.id = "dcStickyList";

    panel.appendChild(compose);
    panel.appendChild(filter);
    panel.appendChild(list);
    wireEvents();
    return true;
  }

  // ============================================================
  // 4. Wire
  // ============================================================
  function wireEvents() {
    // Color picker in compose
    document.querySelectorAll("#dcStickyColorPicker .dc-sticky-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        state.selectedColor = dot.dataset.c;
        document.querySelectorAll("#dcStickyColorPicker .dc-sticky-dot").forEach((d) =>
          d.classList.toggle("active", d === dot)
        );
      });
    });

    // Textarea enabling submit button + ⌘Enter shortcut
    const input = document.getElementById("dcStickyInput");
    const submit = document.getElementById("dcStickyAddBtn");
    input.addEventListener("input", () => {
      submit.disabled = !input.value.trim();
    });
    input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!submit.disabled) submit.click();
      }
    });
    submit.addEventListener("click", addSticky);

    // Scope tabs
    document.querySelectorAll("#dcStickyScopeTabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#dcStickyScopeTabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.scope = btn.dataset.scope;
        loadList();
      });
    });

    // Color filter
    document.querySelectorAll("#dcStickyColorFilter .dc-sticky-dot").forEach((dot) => {
      dot.addEventListener("click", () => {
        if (state.colorFilter === dot.dataset.c) {
          state.colorFilter = null;
          dot.classList.remove("active");
        } else {
          state.colorFilter = dot.dataset.c;
          document.querySelectorAll("#dcStickyColorFilter .dc-sticky-dot").forEach((d) =>
            d.classList.toggle("active", d === dot)
          );
        }
        renderList();
      });
    });
  }

  // ============================================================
  // 5. Data
  // ============================================================
  async function loadStats() {
    const pid = getActivePaperId();
    state.paperId = pid;
    try {
      const r = await fetch(`/api/stickies/stats?paper_id=${encodeURIComponent(pid)}`);
      const d = await r.json();
      state.stats = { paper: d.paper || 0, total: d.total || 0, papers_with_stickies: d.papers_with_stickies || 0 };
    } catch (_) {}
    document.getElementById("dcStickyScopePaperCount").textContent = state.stats.paper;
    document.getElementById("dcStickyScopeAllCount").textContent = state.stats.total;
    // also patch the legacy count display in case other code reads it
    const legacy = document.getElementById("stickyPanelCount");
    if (legacy) legacy.textContent = `${state.stats.paper} 条便签`;
  }

  async function loadList() {
    const pid = getActivePaperId();
    state.paperId = pid;
    try {
      if (state.scope === "paper") {
        if (!pid) {
          state.stickies = [];
        } else {
          const f = await fetch(`/api/annotations?paper_id=${encodeURIComponent(pid)}`);
          if (f.ok) {
            const d = await f.json();
            state.stickies = (d.stickies || []).map((s) => ({ ...s, paper_id: pid }));
          } else {
            state.stickies = [];
          }
        }
      } else {
        const r = await fetch("/api/stickies/all");
        const d = await r.json();
        state.stickies = d.stickies || [];
      }
    } catch (_) {
      state.stickies = [];
    }
    renderList();
  }

  function renderList() {
    const host = document.getElementById("dcStickyList");
    if (!host) return;
    let cards = state.stickies || [];
    if (state.colorFilter) {
      cards = cards.filter((s) => normalizeColor(s.color) === state.colorFilter);
    }
    if (!cards.length) {
      const where = state.scope === "paper" ? "这篇文献" : "整个项目";
      host.innerHTML = `
        <div class="dc-sticky-empty">
          <strong>${where}还没有便签。</strong><br>
          上面写一条然后点「添加便签」，或按 <code>⌘Enter</code> 提交。
        </div>
      `;
      return;
    }
    host.innerHTML = "";
    for (const s of cards) {
      const card = document.createElement("div");
      card.className = "dc-sticky-card";
      card.dataset.id = s.id;
      card.dataset.c = normalizeColor(s.color);
      const time = formatTs(s.updated_at || s.created_at);
      const paperLabel = state.scope === "all" ? shortPaper(s) : "";
      const pageMatch = (s.content || "").match(/@\s*(?:p\.?\s*)?(\d+(?:-\d+)?)\b/i);
      const pageChip = pageMatch ? `<span class="dc-chip dc-chip-mini">p.${pageMatch[1]}</span>` : "";
      card.innerHTML = `
        <div class="dc-sticky-content"></div>
        <div class="dc-sticky-meta">
          <span class="dc-sticky-time">${escapeHtml(time)}</span>
          ${pageChip}
          ${paperLabel ? `<span class="dc-sticky-paper">${escapeHtml(paperLabel)}</span>` : ""}
          <span class="dc-sticky-actions">
            <button data-act="edit" type="button" title="编辑">✎</button>
            <button data-act="delete" type="button" class="danger" title="删除">🗑</button>
          </span>
        </div>
      `;
      card.querySelector(".dc-sticky-content").textContent = s.content || "";
      // Wire actions
      card.querySelector('[data-act="edit"]').addEventListener("click", () => editSticky(card, s));
      card.querySelector('[data-act="delete"]').addEventListener("click", () => deleteSticky(card, s));
      host.appendChild(card);
    }
  }

  function normalizeColor(c) {
    const map = { clay: "orange", yellow: "amber", pink: "red" };
    return map[c] || c || "orange";
  }

  function shortPaper(s) {
    if (s.paper_author && s.paper_year) return `${s.paper_author} ${s.paper_year}`;
    if (s.paper_title) return s.paper_title.slice(0, 32);
    return s.paper_id?.slice(0, 32) || "—";
  }

  function formatTs(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return ts;
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 2) return "昨天 " + d.toTimeString().slice(0, 5);
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return d.toISOString().slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ============================================================
  // 6. Add / Edit / Delete
  // ============================================================
  async function addSticky() {
    const pid = getActivePaperId();
    if (!pid) {
      window.toast?.("请先选中一篇文献", "error");
      return;
    }
    const input = document.getElementById("dcStickyInput");
    const submit = document.getElementById("dcStickyAddBtn");
    const content = input.value.trim();
    if (!content) return;
    submit.disabled = true;
    try {
      const r = await fetch("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_id: pid, content, color: state.selectedColor }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "失败");
      input.value = "";
      // Reload
      await loadStats();
      await loadList();
      window.toast?.("便签已添加", "success");
    } catch (e) {
      window.toast?.("添加失败：" + e.message, "error");
    } finally {
      submit.disabled = !input.value.trim();
    }
  }

  function editSticky(card, s) {
    if (card.classList.contains("editing")) return;
    card.classList.add("editing");
    const content = card.querySelector(".dc-sticky-content");
    const meta = card.querySelector(".dc-sticky-meta");
    const ta = document.createElement("textarea");
    ta.className = "dc-sticky-edit-textarea";
    ta.value = s.content || "";
    content.replaceWith(ta);
    ta.focus();
    // Replace actions with save/cancel
    const actions = card.querySelector(".dc-sticky-actions");
    actions.innerHTML = `
      <button data-act="save" type="button" style="background:var(--dc-accent);color:#fff;border-radius:var(--dc-r-button);padding:2px 10px">保存</button>
      <button data-act="cancel" type="button">取消</button>
    `;
    actions.querySelector('[data-act="save"]').addEventListener("click", async () => {
      try {
        await fetch("/api/annotations/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paper_id: s.paper_id || getActivePaperId(), id: s.id, content: ta.value }),
        });
        await loadList();
      } catch (e) {
        window.toast?.("保存失败：" + e.message, "error");
      }
    });
    actions.querySelector('[data-act="cancel"]').addEventListener("click", () => {
      loadList();
    });
  }

  async function deleteSticky(card, s) {
    if (!confirm("删除这条便签？")) return;
    try {
      await fetch("/api/annotations/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_id: s.paper_id || getActivePaperId(), id: s.id }),
      });
      await loadStats();
      await loadList();
    } catch (e) {
      window.toast?.("删除失败：" + e.message, "error");
    }
  }

  // ============================================================
  // 7. Hook paper switch
  // ============================================================
  const origFetch = window.fetch.bind(window);
  let lastPaperId = "";
  window.fetch = function (...args) {
    const url = args[0];
    if (typeof url === "string") {
      const m = url.match(/\/api\/paper\?paper_id=([^&]+)/);
      if (m) {
        const pid = decodeURIComponent(m[1]);
        if (pid !== lastPaperId) {
          lastPaperId = pid;
          setTimeout(() => {
            loadStats();
            if (state.scope === "paper") loadList();
          }, 50);
        }
      }
    }
    return origFetch(...args);
  };

  // Refresh when user switches to the tab
  document.addEventListener("click", (e) => {
    const tab = e.target.closest('#inspectorTabs .tab[data-tab="annot"]');
    if (tab) setTimeout(() => { loadStats(); loadList(); }, 100);
  });

  // ============================================================
  // 8. Boot
  // ============================================================
  function boot() {
    injectStyles();
    if (mount()) {
      loadStats().then(loadList);
    } else {
      requestAnimationFrame(boot);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
