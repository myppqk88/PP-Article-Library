/* ============================================================================
 * Keyboard shortcuts + theme + paper hover preview.
 *
 * Self-contained additive patch — adds quality-of-life features without
 * touching the legacy app.js wiring:
 *
 *   Ctrl+\           toggle left sidebar
 *   Ctrl+Shift+D     toggle dark mode
 *   /                focus search box (when not already in input)
 *   ?                show shortcuts cheatsheet
 *   Esc              close cheatsheet / modal
 *
 * Plus a hover preview popover for paper rows (400ms delay) showing AI summary
 * + tags + page count.
 * ========================================================================== */

(() => {
  const log = (...args) => console.log("[shortcuts]", ...args);

  // ============================================================
  // 1. Dark mode
  // ============================================================
  const THEME_KEY = "dc-theme";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || "light"; } catch { return "light"; }
  }
  function toggleTheme() {
    applyTheme(getTheme() === "dark" ? "light" : "dark");
  }
  applyTheme(getTheme());

  // ============================================================
  // 2. Inject dark-mode CSS overrides
  // ============================================================
  const darkCss = `
    [data-theme="dark"] {
      --dc-bg: #1a1815;
      --dc-bg-panel: #232019;
      --dc-bg-soft: #2a2620;
      --dc-bg-strong: #2f2b24;
      --dc-panel: #232019;
      --dc-panel-soft: #2a2620;
      --dc-panel-strong: #2f2b24;
      --dc-surface: #232019;
      --dc-text: #e8e4dc;
      --dc-text-strong: #f5f1e8;
      --dc-text-soft: #a8a298;
      --dc-muted: #807a70;
      --dc-muted-soft: #5a554d;
      --dc-line: #3a352c;
      --dc-border: #3a352c;
      --dc-shadow-pop: 0 18px 50px -12px rgba(0,0,0,0.6);
      color-scheme: dark;
    }
    [data-theme="dark"] body { background: var(--dc-bg); color: var(--dc-text); }
    [data-theme="dark"] .panel, [data-theme="dark"] .sidebar, [data-theme="dark"] .inspector,
    [data-theme="dark"] .topbar, [data-theme="dark"] header, [data-theme="dark"] .modal-card,
    [data-theme="dark"] .meta-panel, [data-theme="dark"] .meta-row,
    [data-theme="dark"] .note-toolbar, [data-theme="dark"] .chat-toolbar {
      background: var(--dc-bg-panel);
      color: var(--dc-text);
      border-color: var(--dc-line);
    }
    [data-theme="dark"] input, [data-theme="dark"] textarea, [data-theme="dark"] select {
      background: var(--dc-bg-soft);
      color: var(--dc-text);
      border-color: var(--dc-line);
    }
    [data-theme="dark"] input::placeholder, [data-theme="dark"] textarea::placeholder {
      color: var(--dc-muted-soft);
    }
    [data-theme="dark"] .paper-card, [data-theme="dark"] .paper-row {
      background: var(--dc-bg-panel);
      border-color: var(--dc-line);
    }
    [data-theme="dark"] .paper-card:hover, [data-theme="dark"] .paper-row:hover {
      background: var(--dc-bg-soft);
    }
    [data-theme="dark"] .paper-card.active, [data-theme="dark"] .paper-row.active {
      background: var(--dc-bg-strong);
      border-color: var(--dc-accent, #d97757);
    }
    [data-theme="dark"] .muted, [data-theme="dark"] .text-muted { color: var(--dc-muted); }
    [data-theme="dark"] .notePreview, [data-theme="dark"] #notePreview { background: var(--dc-bg-soft); }
    [data-theme="dark"] code, [data-theme="dark"] pre { background: var(--dc-bg-strong); color: #e8c8a4; }
    [data-theme="dark"] button, [data-theme="dark"] .btn {
      background: var(--dc-bg-soft);
      color: var(--dc-text);
      border-color: var(--dc-line);
    }
    [data-theme="dark"] button:hover, [data-theme="dark"] .btn:hover {
      background: var(--dc-bg-strong);
    }
    [data-theme="dark"] iframe { filter: invert(0.92) hue-rotate(180deg); }
    [data-theme="dark"] .chat-msg-user { background: #2f2b24; }
    [data-theme="dark"] .chat-msg-assistant { background: #232019; }
    /* Theme toggle button visibility */
    .dc-theme-toggle {
      position: fixed; bottom: 18px; right: 18px;
      width: 36px; height: 36px;
      border-radius: 50%;
      background: var(--dc-bg-panel, #fff);
      border: 1px solid var(--dc-line, #d9d6cf);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 12px -4px rgba(20,14,8,0.15);
      z-index: 90;
      font-size: 16px;
      transition: transform 0.2s;
    }
    .dc-theme-toggle:hover { transform: scale(1.1); }

    /* Sidebar collapsed: keep a thin re-open hint visible */
    .app-shell.sidebar-collapsed .sidebar-toggle {
      background: var(--dc-accent, #c8553d);
      color: #fff;
      box-shadow: 0 2px 8px -2px rgba(20,14,8,0.3);
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-shortcuts-style";
  styleEl.textContent = darkCss;
  document.head.appendChild(styleEl);

  // ============================================================
  // 3. Floating dark-mode toggle
  // ============================================================
  function buildThemeToggle() {
    if (document.getElementById("dcThemeToggle")) return;
    const btn = document.createElement("button");
    btn.id = "dcThemeToggle";
    btn.className = "dc-theme-toggle";
    btn.type = "button";
    btn.title = "切换深色模式 (Ctrl+Shift+D)";
    function paint() {
      btn.textContent = getTheme() === "dark" ? "☀" : "☾";
    }
    paint();
    btn.addEventListener("click", () => { toggleTheme(); paint(); });
    document.body.appendChild(btn);
  }
  document.addEventListener("DOMContentLoaded", buildThemeToggle, { once: true });
  // Also build immediately if DOM is already ready (we're loaded as module
  // which may fire after DOMContentLoaded):
  if (document.body) buildThemeToggle();

  // ---- Wire the translate-shortcut capture input (in 翻译 settings) ----
  function wireTranslateShortcutInput() {
    const input = document.getElementById("translateShortcutInput");
    if (input && !input.dataset.wired) {
      input.dataset.wired = "1";
      input.value = localStorage.getItem("dc-translate-shortcut") || "";
      input.addEventListener("keydown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const combo = (() => {
          const parts = [];
          if (e.ctrlKey) parts.push("Ctrl");
          if (e.altKey) parts.push("Alt");
          if (e.shiftKey) parts.push("Shift");
          const k = e.key;
          let main = "";
          if (/^[a-zA-Z0-9]$/.test(k)) main = k.toUpperCase();
          else if (/^F([1-9]|1[0-2])$/.test(k)) main = k;
          else if (k === " ") main = "Space";
          if (!main) return null;  // modifier-only — keep waiting
          parts.push(main);
          return parts.join("+");
        })();
        if (combo) {
          input.value = combo;
          try { localStorage.setItem("dc-translate-shortcut", combo); } catch {}
        }
      });
    }
    const clearBtn = document.getElementById("clearTranslateShortcutBtn");
    if (clearBtn && !clearBtn.dataset.wired) {
      clearBtn.dataset.wired = "1";
      clearBtn.addEventListener("click", () => {
        try { localStorage.removeItem("dc-translate-shortcut"); } catch {}
        const inp = document.getElementById("translateShortcutInput");
        if (inp) inp.value = "";
      });
    }
  }
  document.addEventListener("DOMContentLoaded", wireTranslateShortcutInput, { once: true });
  if (document.body) wireTranslateShortcutInput();

  // ============================================================
  // 4. Keyboard shortcuts
  // ============================================================
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // ---- Configurable translate shortcut ----
  // Stored as a combo string like "Alt+T" / "Ctrl+Shift+Q" in localStorage.
  // The 翻译 settings tab has a capture input + clear button (wired below).
  const TRANSLATE_SHORTCUT_KEY = "dc-translate-shortcut";
  function getTranslateShortcut() {
    try { return localStorage.getItem(TRANSLATE_SHORTCUT_KEY) || ""; }
    catch { return ""; }
  }
  function comboFromEvent(e) {
    // Returns a normalized combo string, or "" if it's a bare modifier press.
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    const k = e.key;
    let main = "";
    if (/^[a-zA-Z0-9]$/.test(k)) main = k.toUpperCase();
    else if (/^F([1-9]|1[0-2])$/.test(k)) main = k;
    else if (["Enter", "Space", " "].includes(k)) main = k === " " ? "Space" : k;
    if (!main) return "";          // modifier-only press
    parts.push(main);
    return parts.join("+");
  }

  document.addEventListener("keydown", (e) => {
    const isMeta = e.metaKey || e.ctrlKey;

    // Configurable translate shortcut. Skip when the user is typing in an
    // input/textarea (so the combo doesn't fire mid-edit) — UNLESS the combo
    // uses a modifier, which is safe in inputs.
    const tc = getTranslateShortcut();
    if (tc && comboFromEvent(e) === tc) {
      const usesModifier = e.ctrlKey || e.altKey || e.metaKey;
      if (usesModifier || !isTypingTarget(e.target)) {
        e.preventDefault();
        const btn = document.getElementById("translateClipboardBtn")
          || document.getElementById("translateBtn")
          || document.querySelector("[data-action='translate']");
        if (btn) btn.click();
        else if (typeof window.translateClipboard === "function") window.translateClipboard();
        return;
      }
    }

    // Ctrl+\ : toggle sidebar
    if (isMeta && e.key === "\\") {
      e.preventDefault();
      document.getElementById("sidebarToggle")?.click();
      return;
    }

    // Ctrl+Shift+D : toggle dark mode
    if (isMeta && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      toggleTheme();
      const btn = document.getElementById("dcThemeToggle");
      if (btn) btn.textContent = getTheme() === "dark" ? "☀" : "☾";
      return;
    }

    // / : focus search (only when not typing in input)
    if (e.key === "/" && !isTypingTarget(e.target) && !isMeta) {
      const search = document.getElementById("searchInput");
      if (search) {
        e.preventDefault();
        search.focus();
        search.select();
      }
      return;
    }

    // ? : show cheatsheet
    if (e.key === "?" && !isTypingTarget(e.target) && !isMeta) {
      e.preventDefault();
      showCheatsheet();
      return;
    }

    // Esc : close cheatsheet
    if (e.key === "Escape") {
      hideCheatsheet();
    }
  });

  // ============================================================
  // 5. Shortcuts cheatsheet
  // ============================================================
  let cheatEl = null;
  function showCheatsheet() {
    if (cheatEl) { cheatEl.classList.remove("hidden"); return; }
    cheatEl = document.createElement("div");
    cheatEl.id = "dcCheatsheet";
    cheatEl.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;" +
      "display:flex;align-items:center;justify-content:center;";
    cheatEl.innerHTML = `
      <div style="background:var(--dc-bg-panel,#fff);color:var(--dc-text,#2b2620);
                  border:1px solid var(--dc-line,#d9d6cf);border-radius:12px;
                  padding:24px;min-width:380px;max-width:480px;
                  box-shadow:0 18px 50px -12px rgba(0,0,0,0.3);">
        <h3 style="margin:0 0 16px 0;font-size:15px;font-weight:600;">键盘快捷键</h3>
        <table style="width:100%;font-size:13px;border-collapse:collapse;">
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">Ctrl + \\</code></td><td style="padding:6px 0;">折叠/展开左侧文献列表</td></tr>
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">Ctrl + Shift + D</code></td><td style="padding:6px 0;">切换深色模式</td></tr>
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">/</code></td><td style="padding:6px 0;">聚焦搜索框</td></tr>
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">Ctrl + Enter</code></td><td style="padding:6px 0;">AI 问答 / 笔记中发送</td></tr>
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">Ctrl + S</code></td><td style="padding:6px 0;">保存设置</td></tr>
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">?</code></td><td style="padding:6px 0;">显示本帮助</td></tr>
          <tr><td style="padding:6px 0;"><code style="background:var(--dc-bg-soft,#f5f1e8);padding:2px 6px;border-radius:4px;">Esc</code></td><td style="padding:6px 0;">关闭弹窗</td></tr>
        </table>
        <div style="text-align:right;margin-top:16px;">
          <button id="dcCheatClose" style="padding:6px 14px;border-radius:6px;border:1px solid var(--dc-line,#d9d6cf);background:var(--dc-bg-soft,#f5f1e8);cursor:pointer;">关闭 (Esc)</button>
        </div>
      </div>
    `;
    document.body.appendChild(cheatEl);
    document.getElementById("dcCheatClose").addEventListener("click", hideCheatsheet);
    cheatEl.addEventListener("click", (e) => { if (e.target === cheatEl) hideCheatsheet(); });
  }
  function hideCheatsheet() {
    if (cheatEl) cheatEl.classList.add("hidden");
    if (cheatEl) cheatEl.remove();
    cheatEl = null;
  }

  // ============================================================
  // 6. Paper-row hover preview popover
  // ============================================================
  const previewCss = `
    .dc-paper-preview {
      position: fixed;
      max-width: 360px;
      min-width: 280px;
      background: var(--dc-bg-panel, #fff);
      color: var(--dc-text, #2b2620);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 10px;
      padding: 14px 16px;
      box-shadow: 0 10px 30px -6px rgba(20,14,8,0.25);
      font-size: 12.5px;
      line-height: 1.55;
      z-index: 180;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      max-height: 60vh;
      overflow-y: auto;
    }
    .dc-paper-preview.visible { opacity: 1; }
    .dc-paper-preview .pp-title {
      font-weight: 600;
      font-size: 13.5px;
      color: var(--dc-text-strong, #1f1a14);
      margin-bottom: 6px;
      line-height: 1.4;
    }
    .dc-paper-preview .pp-meta {
      color: var(--dc-muted, #6b6660);
      font-size: 11.5px;
      margin-bottom: 8px;
    }
    .dc-paper-preview .pp-summary {
      color: var(--dc-text, #2b2620);
      margin-bottom: 8px;
    }
    .dc-paper-preview .pp-tags {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin-top: 6px;
    }
    .dc-paper-preview .pp-tag {
      background: var(--dc-bg-soft, #f5f1e8);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10.5px;
      color: var(--dc-text-soft, #6b6660);
    }
    .dc-paper-preview .pp-stats {
      display: flex; gap: 12px;
      margin-top: 6px;
      font-size: 10.5px;
      color: var(--dc-muted-soft, #a39d94);
    }
  `;
  const previewStyleEl = document.createElement("style");
  previewStyleEl.id = "dc-preview-style";
  previewStyleEl.textContent = previewCss;
  document.head.appendChild(previewStyleEl);

  let previewEl = null;
  let previewTimer = null;
  let lastPaperId = null;

  function ensurePreviewEl() {
    if (previewEl && previewEl.isConnected) return previewEl;
    previewEl = document.createElement("div");
    previewEl.className = "dc-paper-preview";
    document.body.appendChild(previewEl);
    return previewEl;
  }

  async function fetchPaper(paperId) {
    try {
      const r = await fetch(`/api/paper?paper_id=${encodeURIComponent(paperId)}`);
      const d = await r.json();
      return d.paper || null;
    } catch {
      return null;
    }
  }

  function renderPreview(paper, x, y) {
    if (!paper) return;
    const el = ensurePreviewEl();
    const title = paper["英文标题"] || paper["中文标题"] || paper.title || paper.paper_id || "(无标题)";
    const authors = (paper["作者"] || "").split(/[;；]/)[0].trim();
    const year = paper["年份"] || "";
    const venue = paper["期刊会议"] || "";
    const summary = paper["一句话总结"] || paper.one_sentence_summary || "(AI 未生成总结)";
    const tags = [];
    if (paper["一级分类"]) tags.push(...paper["一级分类"].split(/[;；]/).map((s) => s.trim()).filter(Boolean));
    if (paper["二级分类"]) tags.push(...paper["二级分类"].split(/[;；]/).map((s) => s.trim()).filter(Boolean).slice(0, 3));
    const status = paper["阅读状态"] || "";
    const importance = paper["重要性"] || "";
    const journalRank = paper["期刊等级_自动"] || paper["期刊等级_人工"] || "";
    const pdfPages = paper["pdf_pages"] || paper["页数"] || "";

    el.innerHTML = `
      <div class="pp-title">${escapeHtml(title)}</div>
      <div class="pp-meta">${escapeHtml(year)} · ${escapeHtml(authors || "无作者")}${venue ? " · " + escapeHtml(venue) : ""}</div>
      <div class="pp-summary">${escapeHtml(summary)}</div>
      <div class="pp-tags">
        ${tags.slice(0, 6).map((t) => `<span class="pp-tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      <div class="pp-stats">
        ${status ? `📖 ${escapeHtml(status)}` : ""}
        ${importance ? `⭐ ${escapeHtml(importance)}` : ""}
        ${journalRank ? `🏆 ${escapeHtml(journalRank)}` : ""}
        ${pdfPages ? `📄 ${escapeHtml(pdfPages)} 页` : ""}
      </div>
    `;
    // Position: prefer right of hover point; flip to left if off-screen
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = el.getBoundingClientRect();
    let left = x + 12;
    let top = y - 20;
    if (left + 380 > vw) left = Math.max(8, x - 380 - 12);
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.classList.add("visible");
  }

  function hidePreview() {
    if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
    if (previewEl) previewEl.classList.remove("visible");
    lastPaperId = null;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Delegate hover events on the paper list. Look for .paper-card or .paper-row.
  document.addEventListener("mouseover", (e) => {
    const card = e.target.closest && e.target.closest("[data-paper-id]");
    if (!card) return;
    const pid = card.getAttribute("data-paper-id");
    if (!pid || pid === lastPaperId) return;
    lastPaperId = pid;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const paper = await fetchPaper(pid);
      if (paper && lastPaperId === pid) {
        renderPreview(paper, e.clientX, e.clientY);
      }
    }, 400);
  });
  document.addEventListener("mouseout", (e) => {
    const card = e.target.closest && e.target.closest("[data-paper-id]");
    const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-paper-id]");
    if (card && !to) hidePreview();
  });
  // Hide on scroll inside paper list
  document.addEventListener("scroll", hidePreview, true);

  log("ready");
})();
