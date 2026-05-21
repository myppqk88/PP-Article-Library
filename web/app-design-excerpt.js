/* ============================================================
 * 文献工作台 — Design patch: 摘抄 tab
 *
 * Replaces #excerptPanel content with:
 *   ┌─────────────────────────────────┐
 *   │ HERO                            │
 *   │   8  ·  142                     │
 *   │   本文献   好句库合计              │
 *   │  [再抽一轮] [+ 手动添加] [.md 全库] │
 *   │  AI 从本文中挑 6-8 条值得直接引用…  │
 *   └─────────────────────────────────┘
 *   [本文献·N] [本 citation·M] [全库·X]              [最近抽取 ↓]
 *   ┌─ quote card ──────────────────────┐
 *   │ "english quote ..."               │
 *   │ ┌─ note ───────────────────────┐  │
 *   │ │ 用法 explanation             │  │
 *   │ └──────────────────────────────┘  │
 *   │ Fyfe 2024 · p.3 · 综述开场          │
 *   └─────────────────────────────────┘
 *
 * Disables phase5's excerpt-card interceptor (which would fight this
 * patch) — see DISABLE_PHASE5_EXCERPT_FLAG below.
 *
 * Backend endpoints used:
 *   GET /api/excerpts/list?scope=paper|all&paper_id=X&sort=ts_desc|ts_asc
 *   GET /api/excerpts/stats?paper_id=X
 *   POST /api/excerpt  (extract from current paper — existing)
 * ============================================================ */

(function () {
  "use strict";

  // Disable phase5's transient render so this panel owns excerpt UI
  window.__DC_EXCERPT_OWNS = true;

  // ============================================================
  // 1. Scoped styles
  // ============================================================
  function injectStyles() {
    if (document.getElementById("dc-excerpt-style")) return;
    const s = document.createElement("style");
    s.id = "dc-excerpt-style";
    s.textContent = `
      /* Replace old excerpt panel layout */
      #excerptPanel > .panel-actions,
      #excerptPanel > .excerpt-hint,
      #excerptPanel > .ai-answer,
      #excerptPanel > #excerptResult {
        display: none !important;
      }

      #excerptPanel {
        gap: 14px;
      }

      .dc-excerpt-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dc-excerpt-toolbar .dc-pill-tabs { font-size: var(--dc-fs-xs); }
      .dc-excerpt-toolbar .dc-excerpt-sort {
        margin-left: auto;
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        background: transparent;
        border: 1px solid var(--dc-line-soft);
        border-radius: var(--dc-r-pill);
        padding: 3px 10px;
        cursor: pointer;
      }
      .dc-excerpt-toolbar .dc-excerpt-sort:hover {
        border-color: var(--dc-accent);
        color: var(--dc-accent-strong);
      }

      .dc-excerpt-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .dc-excerpt-empty {
        padding: 28px 16px;
        text-align: center;
        font-size: var(--dc-fs-sm);
        color: var(--dc-muted-soft);
        border: 1px dashed var(--dc-line);
        border-radius: var(--dc-r-card);
        background: var(--dc-panel-soft);
        line-height: 1.7;
      }
      .dc-excerpt-empty strong { color: var(--dc-text); }

      .dc-excerpt-card {
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-card);
        padding: 14px 16px 12px 18px;
        position: relative;
        transition: border-color 0.12s, box-shadow 0.12s;
      }
      .dc-excerpt-card:hover {
        border-color: var(--dc-accent-soft);
        box-shadow: var(--dc-shadow-1);
      }
      .dc-excerpt-card.fresh {
        border-color: var(--dc-accent);
        box-shadow: 0 0 0 3px var(--dc-accent-soft);
      }
      .dc-excerpt-card::before {
        content: "“";
        position: absolute;
        top: 8px;
        left: 8px;
        font-family: var(--dc-font-serif);
        font-size: 22px;
        color: var(--dc-accent);
        line-height: 1;
      }
      .dc-excerpt-quote {
        font-family: var(--dc-font-serif);
        font-size: var(--dc-fs-h2);
        line-height: 1.55;
        color: var(--dc-text-strong);
        padding-left: 14px;
      }
      .dc-excerpt-note {
        margin-top: 10px;
        padding: 8px 10px;
        background: var(--dc-panel-soft);
        border-radius: var(--dc-r-input);
        font-size: var(--dc-fs-sm);
        color: var(--dc-text);
        line-height: 1.55;
        display: flex;
        gap: 7px;
        align-items: flex-start;
      }
      .dc-excerpt-note-label {
        flex-shrink: 0;
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        color: var(--dc-muted);
        font-size: var(--dc-fs-xs);
        padding: 1px 7px;
        border-radius: var(--dc-r-pill);
        font-weight: var(--dc-fw-medium);
      }
      .dc-excerpt-foot {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 10px;
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        flex-wrap: wrap;
      }
      .dc-excerpt-foot .dc-excerpt-paper {
        font-family: var(--dc-font-serif);
      }
      .dc-excerpt-foot .dc-chip-mini {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line-soft);
        border-radius: var(--dc-r-pill);
        padding: 1px 6px;
        font-family: var(--dc-font-mono);
        font-size: var(--dc-fs-xxs);
      }
      .dc-excerpt-foot .dc-chip-tag {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
        border: none;
        border-radius: var(--dc-r-pill);
        padding: 1px 8px;
        font-size: var(--dc-fs-xs);
      }
      .dc-excerpt-foot .dc-excerpt-actions {
        margin-left: auto;
        display: flex;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.12s;
      }
      .dc-excerpt-card:hover .dc-excerpt-actions { opacity: 1; }
      .dc-excerpt-actions button {
        border: none;
        background: transparent;
        color: var(--dc-muted);
        font-size: var(--dc-fs-xs);
        padding: 2px 7px;
        border-radius: var(--dc-r-button);
        cursor: pointer;
      }
      .dc-excerpt-actions button:hover {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
      }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  // 2. Mount design shell
  // ============================================================
  let state = {
    scope: "paper", // paper | citation | all
    sort: "ts_desc",
    cards: [],
    paperId: "",
    stats: { paper: 0, total: 0, papers_with_excerpts: 0 },
    fresh_ts: "", // ts of the most-recently-extracted block
  };

  function getActivePaperId() {
    return window.__litHubCurrentPaperId || "";
  }

  function mount() {
    const panel = document.getElementById("excerptPanel");
    if (!panel) return false;
    if (panel.dataset.dcMounted) return true;
    panel.dataset.dcMounted = "1";

    // Hero
    const hero = document.createElement("div");
    hero.className = "dc-hero";
    hero.id = "dcExcerptHero";
    hero.innerHTML = `
      <div class="dc-hero-stats">
        <div class="dc-hero-stat">
          <div class="dc-hero-num" id="dcExHeroPaperNum">—</div>
          <div class="dc-hero-label">本文献</div>
        </div>
        <span class="dc-hero-sep">·</span>
        <div class="dc-hero-stat">
          <div class="dc-hero-num" id="dcExHeroTotalNum">—</div>
          <div class="dc-hero-label">好句库合计</div>
        </div>
      </div>
      <div class="dc-hero-actions">
        <button class="dc-btn dc-btn-primary" id="dcExBtnExtract" type="button">
          <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 2v3M7 9v3M2 7h3M9 7h3M3.5 3.5l2 2M8.5 8.5l2 2M3.5 10.5l2-2M8.5 5.5l2-2"/></svg>
          再抽一轮
        </button>
        <button class="dc-btn" id="dcExBtnAdd" type="button">
          <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3v8M3 7h8"/></svg>
          手动添加
        </button>
        <a class="dc-btn" href="/file?path=library/index/english_excerpts.md" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3h3v3"/><path d="M11 3l-5 5"/><path d="M3 5v6h6V8"/></svg>
          .md 全库
        </a>
      </div>
      <div class="dc-hero-hint">
        AI 从本文中挑 6-8 条值得直接引用的英文原句，附中文用法说明。<br>
        追加写入 <code style="font-family:var(--dc-font-mono);background:var(--dc-surface);padding:1px 5px;border-radius:3px;font-size:11px">library/index/english_excerpts.md</code>。
      </div>
    `;

    // Toolbar (tabs + sort)
    const toolbar = document.createElement("div");
    toolbar.className = "dc-excerpt-toolbar";
    toolbar.id = "dcExToolbar";
    toolbar.innerHTML = `
      <div class="dc-pill-tabs" id="dcExScopeTabs">
        <button class="active" data-scope="paper">本文献<span class="dc-pill-count" id="dcExScopePaperCount">0</span></button>
        <button data-scope="citation">本 citation<span class="dc-pill-count" id="dcExScopeCitationCount">0</span></button>
        <button data-scope="all">全库<span class="dc-pill-count" id="dcExScopeAllCount">0</span></button>
      </div>
      <select class="dc-excerpt-sort" id="dcExSort">
        <option value="ts_desc">最近抽取 ↓</option>
        <option value="ts_asc">最早抽取 ↑</option>
      </select>
    `;

    // List
    const list = document.createElement("div");
    list.className = "dc-excerpt-list";
    list.id = "dcExList";

    panel.appendChild(hero);
    panel.appendChild(toolbar);
    panel.appendChild(list);
    wireEvents();
    return true;
  }

  // ============================================================
  // 3. Wire & render
  // ============================================================
  function wireEvents() {
    // Scope tabs
    document.querySelectorAll("#dcExScopeTabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#dcExScopeTabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.scope = btn.dataset.scope;
        loadList();
      });
    });
    // Sort
    document.getElementById("dcExSort")?.addEventListener("change", (e) => {
      state.sort = e.target.value;
      loadList();
    });
    // Extract button
    document.getElementById("dcExBtnExtract")?.addEventListener("click", extractFromCurrent);
    // Manual add
    document.getElementById("dcExBtnAdd")?.addEventListener("click", manualAdd);
  }

  async function loadStats() {
    const pid = state.paperId || getActivePaperId();
    try {
      const r = await fetch(`/api/excerpts/stats?paper_id=${encodeURIComponent(pid)}`);
      const d = await r.json();
      state.stats = { paper: d.paper || 0, total: d.total || 0, papers_with_excerpts: d.papers_with_excerpts || 0 };
    } catch (_) {
      state.stats = { paper: 0, total: 0, papers_with_excerpts: 0 };
    }
    document.getElementById("dcExHeroPaperNum").textContent = state.stats.paper;
    document.getElementById("dcExHeroTotalNum").textContent = state.stats.total;
    document.getElementById("dcExScopePaperCount").textContent = state.stats.paper;
    document.getElementById("dcExScopeCitationCount").textContent = "—";
    document.getElementById("dcExScopeAllCount").textContent = state.stats.total;
  }

  async function loadList() {
    const pid = state.paperId || getActivePaperId();
    const params = new URLSearchParams({
      scope: state.scope,
      paper_id: pid,
      sort: state.sort,
    });
    try {
      const r = await fetch("/api/excerpts/list?" + params.toString());
      const d = await r.json();
      state.cards = d.cards || [];
    } catch (_) {
      state.cards = [];
    }
    renderList();
  }

  function renderList() {
    const host = document.getElementById("dcExList");
    if (!host) return;
    if (!state.cards.length) {
      const scopeLabel = state.scope === "paper" ? "本文献" : state.scope === "citation" ? "本 citation" : "好句库";
      host.innerHTML = `
        <div class="dc-excerpt-empty">
          <strong>${scopeLabel}还没有摘抄。</strong><br>
          点击 hero 卡片里的「再抽一轮」让 AI 从当前 PDF 挑出几条值得引用的英文原句。
        </div>
      `;
      return;
    }
    host.innerHTML = "";
    for (const c of state.cards) {
      const card = document.createElement("div");
      card.className = "dc-excerpt-card";
      if (state.fresh_ts && c.ts === state.fresh_ts) card.classList.add("fresh");
      const tag = c.tag ? `<span class="dc-chip-tag">${escapeHtml(c.tag)}</span>` : "";
      const page = c.page ? `<span class="dc-chip-mini">p.${escapeHtml(c.page)}</span>` : "";
      const paperLabel = shortPaperLabel(c);
      card.innerHTML = `
        <div class="dc-excerpt-quote"></div>
        ${c.note ? `<div class="dc-excerpt-note"><span class="dc-excerpt-note-label">用法</span><span class="dc-excerpt-note-text"></span></div>` : ""}
        <div class="dc-excerpt-foot">
          <span class="dc-excerpt-paper">${escapeHtml(paperLabel)}</span>
          ${page}
          ${tag}
          <span class="dc-excerpt-actions">
            <button data-act="copy" type="button" title="复制 quote 到剪贴板">
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="6" height="7" rx="1"/><path d="M5 1.5h4a1 1 0 011 1V8"/></svg>
              复制
            </button>
            <button data-act="locate" type="button" title="定位到该文献的对应页码">→ 定位</button>
            <button data-act="to-citation" type="button" title="把这条 quote 追加到当前工作语境的 citation 文件">+ 入 citation</button>
            <button data-act="remove" type="button" class="danger" title="从此次显示中移除（不修改 .md 文件）">
              <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.5h7M4 3.5v-1h4v1M3.5 3.5l.6 7h3.8l.6-7"/></svg>
            </button>
          </span>
        </div>
      `;
      card.querySelector(".dc-excerpt-quote").textContent = c.quote;
      const noteEl = card.querySelector(".dc-excerpt-note-text");
      if (noteEl) noteEl.textContent = c.note;
      // 复制
      card.querySelector('[data-act="copy"]')?.addEventListener("click", () => {
        try {
          navigator.clipboard.writeText(c.quote);
          window.toast?.("已复制 quote", "success");
        } catch (_) {}
      });
      // → 定位 = open paper + jump PDF to page
      card.querySelector('[data-act="locate"]')?.addEventListener("click", () => {
        if (!c.paper_id) return;
        for (const it of document.querySelectorAll(".paper-item")) {
          if (it.dataset.paperId === c.paper_id || it.textContent.includes(c.paper_id)) {
            it.click();
            break;
          }
        }
        // After selectPaper loads the PDF, jump to page via iframe #page=N
        if (c.page) {
          setTimeout(() => {
            const iframe = document.querySelector(".pdfv-iframe, #pdfViewer iframe");
            if (!iframe) return;
            try {
              const url = new URL(iframe.src, location.href);
              url.hash = `page=${c.page.split('-')[0]}`;
              iframe.src = url.toString();
            } catch (_) {}
          }, 800);
        }
      });
      // + 入 citation
      card.querySelector('[data-act="to-citation"]')?.addEventListener("click", async () => {
        const sel = document.getElementById("aiWorkContext");
        const citation = sel?.value || "";
        if (!citation) {
          window.toast?.("请先在 AI 面板顶部选一个 citation 工作语境", "error");
          return;
        }
        try {
          const entry = `\n\n- **Quote**: "${c.quote}"\n  - **Source**: ${paperLabel}${c.page ? ` · p.${c.page}` : ""}\n  - **用法**: ${c.note || "—"}\n`;
          const cur = await (await fetch(`/api/citation?name=${encodeURIComponent(citation)}`)).json();
          const newRaw = (cur.citation?.raw || "") + entry;
          await fetch("/api/citation/save", {
            method: "POST", headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ name: citation, raw: newRaw }),
          });
          window.toast?.(`已追加到 ${citation}.md`, "success");
        } catch (e) {
          window.toast?.("追加失败：" + e.message, "error");
        }
      });
      // 🗑 = remove from current view only
      card.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
        card.style.transition = "opacity 0.2s, transform 0.2s";
        card.style.opacity = "0";
        card.style.transform = "translateX(8px)";
        setTimeout(() => card.remove(), 200);
      });
      host.appendChild(card);
    }
  }

  function shortPaperLabel(c) {
    // Use Source line if available — usually "authors; year; venue; doi"
    if (c.source) {
      const parts = c.source.split(/[;；]/);
      if (parts.length >= 2) {
        const author = parts[0].trim().split(/[\s,，]/)[0];
        const year = (parts.find((p) => /\b(19|20)\d{2}\b/.test(p)) || "").trim().match(/(19|20)\d{2}/)?.[0];
        if (year) return `${author} ${year}`;
        return author;
      }
    }
    // Fall back to paper_id (e.g. 2020_Erika_Lilja_policy → "Lilja 2020")
    const id = c.paper_id || "";
    const m = id.match(/^(\d{4})_([^_]+)/);
    if (m) return `${m[2].replace(/-/g, " ")} ${m[1]}`;
    return c.paper_title?.slice(0, 32) || "—";
  }

  // ============================================================
  // 4. Actions
  // ============================================================
  async function extractFromCurrent() {
    const pid = getActivePaperId();
    if (!pid) {
      window.toast?.("请先选中一篇文献", "error");
      return;
    }
    const btn = document.getElementById("dcExBtnExtract");
    btn.disabled = true;
    btn.innerHTML = `<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/></svg> AI 摘抄中…`;
    try {
      const r = await fetch("/api/excerpt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_id: pid, append_note: false }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "失败");
      window.toast?.("已追加到好句库", "success");
      // Mark new entries as fresh
      const now = new Date();
      state.fresh_ts = `${now.toISOString().slice(0, 10)} ${now.toTimeString().slice(0, 8)}`;
      // Wait briefly for backend to flush
      await new Promise(r => setTimeout(r, 250));
      state.scope = "paper";
      document.querySelectorAll("#dcExScopeTabs button").forEach((b) => b.classList.toggle("active", b.dataset.scope === "paper"));
      await loadStats();
      await loadList();
    } catch (e) {
      window.toast?.("摘抄失败：" + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 2v3M7 9v3M2 7h3M9 7h3M3.5 3.5l2 2M8.5 8.5l2 2M3.5 10.5l2-2M8.5 5.5l2-2"/></svg> 再抽一轮`;
    }
  }

  function manualAdd() {
    window.toast?.("手动添加：请直接编辑 library/index/english_excerpts.md 文件，添加完后点击「再抽一轮」旁边的「.md 全库」按 ↓ 刷新。也可以稍后我们做个 inline 编辑器。", "info");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ============================================================
  // 5. Refresh on paper switch + tab switch
  // ============================================================
  function refresh() {
    const pid = getActivePaperId();
    if (pid !== state.paperId) state.paperId = pid;
    loadStats().then(loadList);
  }

  // Observe URL changes (paper_id query)
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
          state.paperId = pid;
          // Refresh excerpt panel data even if hidden — cheap stats call only
          setTimeout(() => loadStats(), 50);
        }
      }
    }
    return origFetch(...args);
  };

  // Refresh on showing the tab
  document.addEventListener("click", (e) => {
    const tab = e.target.closest('#inspectorTabs .tab[data-tab="excerpt"]');
    if (tab) setTimeout(refresh, 100);
  });

  // ============================================================
  // 6. Boot
  // ============================================================
  function boot() {
    injectStyles();
    if (mount()) {
      refresh();
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
