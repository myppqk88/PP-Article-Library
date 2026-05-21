/* ============================================================
 * 文献工作台 — Phase 3: command palette + view modes + multi-select.
 *
 * Pure-frontend additions. Reads paper list from /api/papers; for paper
 * selection it locates the matching sidebar item and dispatches a click.
 * (We can't reach app.js's module-scoped selectPaper from another module.)
 * ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // 1. Command palette (⌘K / Ctrl+K)
  // ============================================================
  let allPapers = [];
  let lastPapersFetch = 0;
  let cmdFocusedIdx = 0;
  let cmdResults = []; // {kind, label, sub, action}

  async function refreshPapersCache() {
    // Cache for 30 s — fast enough that the palette feels live
    if (Date.now() - lastPapersFetch < 30_000 && allPapers.length) return;
    try {
      const resp = await fetch("/api/papers");
      if (!resp.ok) return;
      const data = await resp.json();
      allPapers = (data.papers || []).map((p) => ({
        paper_id: p.paper_id,
        title_en: p.title_en || p.title || "",
        title_zh: p.title_zh || p["中文标题"] || "",
        authors: p.authors || p["作者"] || "",
        year: p.year || p["年份"] || "",
        venue: p.venue || p["期刊/会议"] || "",
      }));
      lastPapersFetch = Date.now();
    } catch (_) {}
  }

  function openCmd() {
    const bd = document.getElementById("cmdPalette");
    if (!bd) return;
    refreshPapersCache();
    bd.classList.add("show");
    const input = document.getElementById("cmdInput");
    if (input) {
      input.value = "";
      input.focus();
      renderCmdResults("");
    }
  }
  function closeCmd() {
    const bd = document.getElementById("cmdPalette");
    if (bd) bd.classList.remove("show");
  }

  function fuzzyScore(needle, hay) {
    if (!needle) return 0;
    const n = needle.toLowerCase();
    const h = (hay || "").toLowerCase();
    if (!h) return -1;
    if (h.includes(n)) return 100 - (h.indexOf(n) * 0.5);
    // letter-by-letter
    let hi = 0;
    for (let i = 0; i < n.length; i++) {
      const ci = h.indexOf(n[i], hi);
      if (ci < 0) return -1;
      hi = ci + 1;
    }
    return 30;
  }

  function buildCommands() {
    return [
      {
        kind: "cmd",
        label: "整理新文献",
        sub: "扫 inbox/ 把新 PDF 入库",
        action: () => {
          closeCmd();
          document.getElementById("organizeBtn")?.click();
        },
      },
      {
        kind: "cmd",
        label: "打开设置",
        sub: "AI / 翻译 / 主题 / 提示词",
        action: () => {
          closeCmd();
          document.getElementById("settingsBtn")?.click();
        },
      },
      {
        kind: "cmd",
        label: "按分类导出",
        sub: "把某分类的 PDF + 笔记复制到 exports/",
        action: () => {
          closeCmd();
          document.getElementById("exportCategoryBtn")?.click();
        },
      },
      {
        kind: "cmd",
        label: "批量刷新期刊等级",
        sub: "调 EasyScholar 把空值补上",
        action: () => {
          closeCmd();
          document.getElementById("refreshRankAllBtn")?.click();
        },
      },
      {
        kind: "cmd",
        label: "刷新扫描标记",
        sub: "识别哪些是扫描版 PDF",
        action: () => {
          closeCmd();
          document.getElementById("scanRefreshBtn")?.click();
        },
      },
      {
        kind: "cmd",
        label: "主题：陶土橘",
        sub: "默认 · Claude 暖米",
        action: () => {
          applyTheme("clay");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "主题：黑白",
        sub: "极简 · 高对比",
        action: () => {
          applyTheme("mono");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "主题：森林",
        sub: "鼠尾草绿",
        action: () => {
          applyTheme("forest");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "主题：深海",
        sub: "犹丝蓝",
        action: () => {
          applyTheme("ocean");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "视图：紧凑",
        sub: "侧栏卡片单行",
        action: () => {
          applyViewMode("compact");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "视图：舒展",
        sub: "侧栏默认显示",
        action: () => {
          applyViewMode("default");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "视图：表格",
        sub: "侧栏密集表格",
        action: () => {
          applyViewMode("table");
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "批量选择模式",
        sub: "勾选多篇 → 改分类 / 删除",
        action: () => {
          enterBulkMode();
          closeCmd();
        },
      },
      {
        kind: "cmd",
        label: "折叠/展开侧栏",
        sub: "/",
        action: () => {
          closeCmd();
          document.getElementById("sidebarToggle")?.click();
        },
      },
    ];
  }

  function applyTheme(t) {
    document.body.classList.remove(
      "theme-clay",
      "theme-mono",
      "theme-forest",
      "theme-ocean"
    );
    if (t !== "clay") document.body.classList.add("theme-" + t);
    try {
      localStorage.setItem("lit-hub-theme", t);
    } catch (_) {}
    document
      .querySelectorAll("#themePicker button[data-theme]")
      .forEach((b) => b.classList.toggle("active", b.dataset.theme === t));
  }

  function renderCmdResults(query) {
    const list = document.getElementById("cmdResults");
    if (!list) return;
    cmdResults = [];
    const q = (query || "").trim();

    // 1. commands always available
    const commands = buildCommands();
    if (!q) {
      cmdResults.push({ section: "命令" });
      commands.forEach((c) => cmdResults.push(c));
      // recent papers
      if (allPapers.length) {
        cmdResults.push({ section: "文献" });
        allPapers.slice(0, 10).forEach((p) => cmdResults.push(paperRow(p)));
      }
    } else {
      const cmdScored = commands
        .map((c) => ({
          c,
          score: Math.max(fuzzyScore(q, c.label), fuzzyScore(q, c.sub)),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c);

      const paperScored = allPapers
        .map((p) => {
          const s = Math.max(
            fuzzyScore(q, p.title_en),
            fuzzyScore(q, p.title_zh),
            fuzzyScore(q, p.authors),
            fuzzyScore(q, p.venue)
          );
          return { p, score: s };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((x) => paperRow(x.p));

      if (cmdScored.length) {
        cmdResults.push({ section: "命令" });
        cmdScored.forEach((c) => cmdResults.push(c));
      }
      if (paperScored.length) {
        cmdResults.push({ section: `文献 (${paperScored.length})` });
        paperScored.forEach((p) => cmdResults.push(p));
      }
    }

    // Render
    list.innerHTML = "";
    if (!cmdResults.length) {
      list.innerHTML = `<div class="cmd-empty">没找到匹配。试试别的关键词。</div>`;
      return;
    }
    cmdFocusedIdx = -1;
    let firstSelectable = -1;
    cmdResults.forEach((item, i) => {
      if (item.section) {
        const sec = document.createElement("div");
        sec.className = "cmd-section";
        sec.textContent = item.section;
        list.appendChild(sec);
      } else {
        const row = document.createElement("div");
        row.className = "cmd-row";
        row.dataset.idx = String(i);
        row.innerHTML = `
          <span class="cmd-icon">${item.kind === "paper" ? paperIcon() : cmdIcon()}</span>
          <div class="cmd-main">
            <div class="cmd-title"></div>
            <div class="cmd-sub"></div>
          </div>
          ${item.kbd ? `<span class="cmd-kbd">${item.kbd}</span>` : ""}
        `;
        row.querySelector(".cmd-title").textContent = item.label;
        row.querySelector(".cmd-sub").textContent = item.sub || "";
        row.addEventListener("click", () => item.action && item.action());
        list.appendChild(row);
        if (firstSelectable < 0) firstSelectable = i;
      }
    });
    if (firstSelectable >= 0) focusCmdRow(firstSelectable);
  }

  function paperRow(p) {
    return {
      kind: "paper",
      label: p.title_zh || p.title_en || p.paper_id,
      sub: [
        p.authors,
        p.year,
        p.venue,
      ].filter(Boolean).join(" · "),
      action: () => {
        closeCmd();
        openPaperByTitle(p.title_en || p.title_zh, p.paper_id);
      },
    };
  }

  function paperIcon() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14"><path d="M4 2h6l2 2v10H4z"/><path d="M4 6h8M4 9h6M4 12h4"/></svg>';
  }
  function cmdIcon() {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14"><circle cx="8" cy="8" r="5"/><path d="M5.5 8h5M8 5.5v5"/></svg>';
  }

  function focusCmdRow(idx) {
    const list = document.getElementById("cmdResults");
    if (!list) return;
    list.querySelectorAll(".cmd-row").forEach((r) => r.classList.remove("cmd-focused"));
    const row = list.querySelector(`.cmd-row[data-idx="${idx}"]`);
    if (row) {
      row.classList.add("cmd-focused");
      cmdFocusedIdx = idx;
      row.scrollIntoView({ block: "nearest" });
    }
  }

  function moveCmdFocus(delta) {
    const items = cmdResults
      .map((it, i) => (it.section ? null : i))
      .filter((i) => i !== null);
    if (!items.length) return;
    const curPos = items.indexOf(cmdFocusedIdx);
    let next = curPos + delta;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    focusCmdRow(items[next]);
  }

  function activateFocused() {
    if (cmdFocusedIdx < 0) return;
    const item = cmdResults[cmdFocusedIdx];
    if (item && item.action) item.action();
  }

  function openPaperByTitle(titleEn, paperId) {
    // Set search input, clear filters; then click the matching item.
    const searchInput = document.getElementById("searchInput");
    const filters = ["categorySelect", "readStatusFilter", "importanceFilter"];
    filters.forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.value) {
        el.value = "";
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    if (searchInput) {
      searchInput.value = titleEn ? titleEn.slice(0, 40) : "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // Wait for re-render
    setTimeout(() => {
      const list = document.getElementById("paperList");
      if (!list) return;
      const items = list.querySelectorAll(".paper-item, .paper-card");
      for (const item of items) {
        const title = item.querySelector(".paper-title")?.textContent || "";
        if (
          (titleEn && title.includes(titleEn.slice(0, 24))) ||
          (title && titleEn && titleEn.includes(title.slice(0, 24)))
        ) {
          item.click();
          item.scrollIntoView({ block: "center" });
          return;
        }
      }
      // Fallback: click first match
      const first = items[0];
      if (first) first.click();
    }, 220);
  }

  document.addEventListener("keydown", (e) => {
    const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
    if (isCmdK) {
      e.preventDefault();
      openCmd();
      return;
    }
    const palette = document.getElementById("cmdPalette");
    if (!palette || !palette.classList.contains("show")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeCmd();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveCmdFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveCmdFocus(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activateFocused();
    }
  });

  // Click outside palette closes it
  document.addEventListener("click", (e) => {
    const bd = document.getElementById("cmdPalette");
    if (!bd || !bd.classList.contains("show")) return;
    if (e.target === bd) closeCmd();
  });

  // Wire up the input
  document.addEventListener("input", (e) => {
    if (e.target.id === "cmdInput") renderCmdResults(e.target.value);
  });

  // ============================================================
  // 2. View modes (default / compact / table)
  // ============================================================
  const VIEW_MODE_KEY = "lit-hub-view-mode";

  function injectViewModeBar() {
    if (document.getElementById("viewModeBar")) return;
    const sidebar = document.querySelector(".sidebar");
    const paperCount = document.getElementById("paperCount");
    if (!sidebar || !paperCount) return;
    const bar = document.createElement("div");
    bar.id = "viewModeBar";
    bar.className = "view-mode-bar";
    bar.innerHTML = `
      <div class="seg">
        <button data-mode="default" type="button">舒展</button>
        <button data-mode="compact" type="button">紧凑</button>
        <button data-mode="table" type="button">表格</button>
      </div>
      <span style="flex:1"></span>
      <button id="bulkModeBtn" type="button" class="seg" style="padding:3px 9px;font-size:11px;border:1px solid var(--line);background:var(--panel-soft);color:var(--muted);cursor:pointer;border-radius:6px">选择多篇</button>
    `;
    sidebar.insertBefore(bar, paperCount);
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-mode]");
      if (b) applyViewMode(b.dataset.mode);
      const bulkBtn = e.target.closest("#bulkModeBtn");
      if (bulkBtn) {
        if (document.body.classList.contains("bulk-mode-on")) exitBulkMode();
        else enterBulkMode();
      }
    });
    const saved = (() => {
      try { return localStorage.getItem(VIEW_MODE_KEY) || "default"; }
      catch (_) { return "default"; }
    })();
    applyViewMode(saved);
  }

  function applyViewMode(mode) {
    const list = document.getElementById("paperList");
    if (!list) return;
    list.classList.remove("view-default", "view-compact", "view-table");
    list.classList.add("view-" + mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (_) {}
    document
      .querySelectorAll("#viewModeBar button[data-mode]")
      .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  }

  // ============================================================
  // 3. Bulk select mode
  // ============================================================
  const selected = new Set();

  function enterBulkMode() {
    document.body.classList.add("bulk-mode-on");
    const list = document.getElementById("paperList");
    if (list) list.classList.add("bulk-mode");
    const bar = document.getElementById("bulkActionBar");
    if (bar) bar.classList.remove("hidden");
    updateBulkCount();
    const btn = document.getElementById("bulkModeBtn");
    if (btn) {
      btn.textContent = "退出多选";
      btn.style.color = "var(--accent-strong)";
      btn.style.borderColor = "var(--accent)";
      btn.style.background = "var(--accent-tint)";
    }
  }
  function exitBulkMode() {
    document.body.classList.remove("bulk-mode-on");
    const list = document.getElementById("paperList");
    if (list) {
      list.classList.remove("bulk-mode");
      list.querySelectorAll(".selected").forEach((el) => el.classList.remove("selected"));
    }
    selected.clear();
    const bar = document.getElementById("bulkActionBar");
    if (bar) bar.classList.add("hidden");
    const btn = document.getElementById("bulkModeBtn");
    if (btn) {
      btn.textContent = "选择多篇";
      btn.style.color = "";
      btn.style.borderColor = "";
      btn.style.background = "";
    }
  }
  function updateBulkCount() {
    const cnt = document.getElementById("bulkCount");
    if (cnt) cnt.textContent = String(selected.size);
  }

  // Get paper_id from a paper-item by matching its title to allPapers
  function paperIdFromItem(item) {
    const title = item.querySelector(".paper-title")?.textContent || "";
    if (!title) return null;
    const cached = item.dataset.paperId;
    if (cached) return cached;
    const head = title.slice(0, 30);
    const match = allPapers.find(
      (p) => (p.title_en || "").startsWith(head) || (p.title_zh || "").startsWith(head)
    );
    if (match) {
      item.dataset.paperId = match.paper_id;
      return match.paper_id;
    }
    return null;
  }

  // Intercept clicks on paper-items in bulk mode
  document.addEventListener(
    "click",
    (e) => {
      if (!document.body.classList.contains("bulk-mode-on")) return;
      const item = e.target.closest(".paper-item, .paper-card");
      if (!item) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const pid = paperIdFromItem(item);
      if (!pid) return;
      if (selected.has(pid)) {
        selected.delete(pid);
        item.classList.remove("selected");
      } else {
        selected.add(pid);
        item.classList.add("selected");
      }
      updateBulkCount();
    },
    { capture: true }
  );

  // Wire bulk-action-bar buttons
  document.addEventListener("click", (e) => {
    if (e.target.closest("#bulkCancelBtn")) {
      exitBulkMode();
    } else if (e.target.closest("#bulkDeleteBtn")) {
      runBulkDelete();
    } else if (e.target.closest("#bulkStatusBtn")) {
      runBulkStatus();
    } else if (e.target.closest("#bulkReadBtn")) {
      runBulkRead();
    } else if (e.target.closest("#bulkRankBtn")) {
      runBulkRefreshRank();
    } else if (e.target.closest("#bulkMultiAskBtn")) {
      runBulkMultiAsk();
    } else if (e.target.closest("#bulkCategorizeBtn")) {
      runBulkCategorize();
    } else if (e.target.closest("#bulkExportBtn")) {
      runBulkExport();
    }
  });

  async function runBulkDelete() {
    if (!selected.size) return;
    if (!confirm(`确认删除选中的 ${selected.size} 篇文献？\n\n会删除 PDF、笔记、缓存。此操作不可撤销。`)) return;
    const ids = Array.from(selected);
    let ok = 0,
      fail = 0;
    for (const pid of ids) {
      try {
        const resp = await fetch("/api/paper/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paper_id: pid }),
        });
        if (resp.ok) ok++;
        else fail++;
      } catch (_) {
        fail++;
      }
    }
    alert(`完成。\n成功 ${ok} 篇，失败 ${fail} 篇。\n刷新一下页面看新列表。`);
    exitBulkMode();
    // trigger a list refresh by simulating a filter change
    const searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function runBulkStatus() {
    if (!selected.size) return;
    const options = ["AI初整", "待读", "已读", "精读", ""];
    const newStatus = prompt(
      `要把 ${selected.size} 篇改成什么阅读状态？\n\n输入下面之一（空字符串=未定）：\n${options.filter(Boolean).join(" / ")}`,
      "已读"
    );
    if (newStatus === null) return;
    const allowed = new Set(options);
    if (!allowed.has(newStatus)) {
      alert("无效的状态值。");
      return;
    }
    let ok = 0,
      fail = 0;
    for (const pid of selected) {
      try {
        const resp = await fetch("/api/paper/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paper_id: pid,
            patch: { 阅读状态: newStatus },
          }),
        });
        if (resp.ok) ok++;
        else fail++;
      } catch (_) {
        fail++;
      }
    }
    alert(`完成。成功 ${ok} 篇，失败 ${fail} 篇。`);
    exitBulkMode();
    const searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---- Generic bulk-job runner: drives 批量阅读 and 批量刷新等级 ----
  // Iterates the selected papers serially, POSTing one endpoint per paper,
  // with a shared progress modal (bar + elapsed + per-item failures + cancel).
  let bulkJobCancelled = false;

  function titleForPaperId(pid) {
    const p = allPapers.find((x) => x.paper_id === pid);
    if (p) return p.title_zh || p.title_en || pid;
    return pid;
  }

  function buildBulkProgressModal(headTitle, total) {
    let m = document.getElementById("bulkJobModal");
    if (m) m.remove();
    m = document.createElement("div");
    m.id = "bulkJobModal";
    m.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:1100;" +
      "display:flex;align-items:center;justify-content:center;";
    m.innerHTML = `
      <div style="background:var(--dc-bg-panel,#fff);color:var(--dc-text,#2b2620);
                  border:1px solid var(--dc-line,#d9d6cf);border-radius:12px;
                  width:min(92vw,460px);padding:20px 22px;
                  box-shadow:0 20px 60px -10px rgba(0,0,0,0.4);font-size:13px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <strong id="bulkJobTitle" style="font-size:14px">${headTitle} 0 / ${total}</strong>
          <span id="bulkJobElapsed" style="font-size:11px;color:var(--dc-muted,#6b6660);font-variant-numeric:tabular-nums"></span>
        </div>
        <div style="height:8px;background:var(--dc-bg-soft,#f5f1e8);border-radius:999px;overflow:hidden;margin-bottom:10px">
          <div id="bulkJobFill" style="height:100%;width:0%;background:var(--dc-accent,#c8553d);transition:width .3s"></div>
        </div>
        <div id="bulkJobCurrent" style="font-size:12px;color:var(--dc-text-soft,#6b6660);
             margin-bottom:8px;min-height:32px;line-height:1.5;word-break:break-word"></div>
        <div style="display:flex;gap:14px;font-size:12px;margin-bottom:8px">
          <span>✓ 成功 <strong id="bulkJobOk">0</strong></span>
          <span>✗ 失败 <strong id="bulkJobFail">0</strong></span>
        </div>
        <div id="bulkJobLog" style="font-size:11px;max-height:140px;overflow-y:auto;
             background:var(--dc-bg-soft,#f5f1e8);border-radius:6px;padding:6px 8px;
             display:none;line-height:1.6"></div>
        <div style="text-align:right;margin-top:14px">
          <button id="bulkJobCancelBtn" type="button"
                  style="padding:6px 16px;border-radius:6px;border:1px solid var(--dc-line,#d9d6cf);
                         background:var(--dc-bg-soft,#f5f1e8);color:var(--dc-text,#2b2620);cursor:pointer">
            取消（完成当前篇后停止）
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(m);
    document.getElementById("bulkJobCancelBtn").addEventListener("click", () => {
      bulkJobCancelled = true;
      const b = document.getElementById("bulkJobCancelBtn");
      b.textContent = "停止中…";
      b.disabled = true;
    });
    return m;
  }

  /**
   * Run a serial bulk job over the selected papers.
   * opts: { headTitle, verb, endpoint, bodyFor(pid)->obj, confirmText(n)->string }
   */
  async function runBulkJob(opts) {
    if (!selected.size) return;
    const ids = Array.from(selected);
    await refreshPapersCache();
    if (opts.confirmText && !confirm(opts.confirmText(ids.length))) return;

    bulkJobCancelled = false;
    window.__bulkReadRunning = true;  // suppress single-paper help-read overlay
    buildBulkProgressModal(opts.headTitle, ids.length);
    const t0 = Date.now();
    const elapsedTimer = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      const el = document.getElementById("bulkJobElapsed");
      if (el) el.textContent = `已用 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    }, 500);

    let ok = 0, fail = 0;
    const failures = [];
    for (let i = 0; i < ids.length; i++) {
      if (bulkJobCancelled) break;
      const pid = ids[i];
      const title = titleForPaperId(pid);
      const titleEl = document.getElementById("bulkJobTitle");
      const curEl = document.getElementById("bulkJobCurrent");
      if (titleEl) titleEl.textContent = `${opts.headTitle} ${i} / ${ids.length}`;
      if (curEl) curEl.textContent = `正在${opts.verb}第 ${i + 1} 篇：${title}`;
      try {
        const resp = await fetch(opts.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts.bodyFor(pid)),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.ok !== false) {
          ok++;
        } else {
          fail++;
          failures.push({ title, error: data.error || `HTTP ${resp.status}` });
        }
      } catch (e) {
        fail++;
        failures.push({ title, error: String(e && e.message ? e.message : e) });
      }
      const done = i + 1;
      const fill = document.getElementById("bulkJobFill");
      if (fill) fill.style.width = `${(done / ids.length) * 100}%`;
      const okEl = document.getElementById("bulkJobOk");
      const failEl = document.getElementById("bulkJobFail");
      if (okEl) okEl.textContent = String(ok);
      if (failEl) failEl.textContent = String(fail);
      if (failures.length) {
        const logEl = document.getElementById("bulkJobLog");
        if (logEl) {
          logEl.style.display = "block";
          logEl.innerHTML = failures
            .map((f) => `<div style="color:#c0392b">✗ ${escapeHtmlLocal(f.title)}：${escapeHtmlLocal(f.error)}</div>`)
            .join("");
        }
      }
    }

    clearInterval(elapsedTimer);
    window.__bulkReadRunning = false;

    const titleEl = document.getElementById("bulkJobTitle");
    const curEl = document.getElementById("bulkJobCurrent");
    if (titleEl) {
      titleEl.textContent = bulkJobCancelled
        ? `已取消 · 完成 ${ok + fail} / ${ids.length}`
        : `${opts.headTitle}完成 ${ids.length} / ${ids.length}`;
    }
    if (curEl) {
      curEl.textContent = `成功 ${ok} 篇，失败 ${fail} 篇。`
        + (failures.length ? "失败明细见下方。" : "");
    }
    const cancelBtn = document.getElementById("bulkJobCancelBtn");
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = "关闭";
      cancelBtn.onclick = () => {
        document.getElementById("bulkJobModal")?.remove();
        exitBulkMode();
        const searchInput = document.getElementById("searchInput");
        if (searchInput) searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      };
    }
  }

  // Push the bulk selection into the AI panel's 多篇文献集 (app-design-multiask.js
  // listens for this event), then exit bulk mode.
  function runBulkMultiAsk() {
    if (!selected.size) return;
    document.dispatchEvent(new CustomEvent("dc-multi-ask-papers", {
      detail: { paper_ids: Array.from(selected) },
    }));
    exitBulkMode();
  }

  function runBulkRead() {
    return runBulkJob({
      headTitle: "批量阅读",
      verb: "阅读",
      endpoint: "/api/paper/help-read",
      bodyFor: (pid) => ({ paper_id: pid }),
      confirmText: (n) => {
        const lo = Math.ceil((n * 30) / 60);
        const hi = Math.ceil((n * 120) / 60);
        return (
          `对选中的 ${n} 篇文献逐个执行「帮我阅读」？\n\n` +
          `每篇都会调 AI 刷新元数据 + 笔记正文（不动你的分类、备注、人工笔记区）。\n` +
          `按当前模型速度，预计共需 ${lo}–${hi} 分钟。期间可随时点「取消」。`
        );
      },
    });
  }

  function runBulkRefreshRank() {
    return runBulkJob({
      headTitle: "批量刷新期刊等级",
      verb: "刷新",
      endpoint: "/api/easyscholar/refresh",
      bodyFor: (pid) => ({ paper_id: pid, force_refresh: true }),
      confirmText: (n) =>
        `对选中的 ${n} 篇文献刷新 EasyScholar 期刊等级？\n\n` +
        `只写入「期刊等级_自动」字段，你手填的「期刊等级_人工」不受影响。\n` +
        `比 AI 阅读快很多（每篇约 1-2 秒）。需要在 设置→期刊等级源 配好 secret key。`,
    });
  }

  function escapeHtmlLocal(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function runBulkCategorize() {
    if (!selected.size) return;
    alert(
      `批量改分类目前只支持一级分类。\n请使用单篇分类弹窗做精细调整。\n\n（想批量挂多级？告诉我们，后续可加。）`
    );
    const primary = prompt(`把 ${selected.size} 篇文献挂到哪个一级分类？\n（已存在的一级分类，输入完整名）`, "");
    if (!primary) return;
    let ok = 0,
      fail = 0;
    for (const pid of selected) {
      try {
        const resp = await fetch("/api/paper/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paper_id: pid,
            patch: { 分类_人工_一级: primary },
          }),
        });
        if (resp.ok) ok++;
        else fail++;
      } catch (_) {
        fail++;
      }
    }
    alert(`完成。成功 ${ok} 篇，失败 ${fail} 篇。`);
    exitBulkMode();
  }

  function runBulkExport() {
    alert(
      "批量导出 = 按分类导出。\n\n请先把选中文献都改到同一分类，再用顶栏 ⋯ 菜单的「按分类导出」。"
    );
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    injectViewModeBar();
    // First fetch happens lazily when palette opens or bulk paperIdFromItem is called.
    refreshPapersCache();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
