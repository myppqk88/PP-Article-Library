/* ============================================================
 * 文献工作台 — Design patch: 设置弹窗
 *
 * Restructure the settings modal:
 *   - horizontal tabs → vertical sidebar nav with section headers
 *     (AI 调用 / 文献数据 / 界面)
 *   - 主模型 detail pane gets a 连接状态卡 with [重新测试] button
 *   - bottom footer: ● 未修改 ········ [取消] [保存 ⌘S]
 *
 * Behavior preserved: each existing settings-section keeps its own
 * inputs and save buttons. This patch only adds visual chrome and a
 * ping-test endpoint (/api/llm/ping). The footer 「保存」 button just saves
 * (no auto-ping — user was getting surprised by tests firing on every save,
 * and the conn card already wasn't reflecting the newly-picked provider until
 * after save anyway).
 *
 * For provider switching, the conn card has TWO buttons:
 *   [切换] — applies the active provider tab + refreshes the conn card display
 *   [重新测试] — pings the (now-saved) provider
 * ============================================================ */

(function () {
  "use strict";

  // Mapping of settings-tab name → group + title + subtitle
  const NAV = {
    model:       { group: "AI 调用",   label: "主模型",       subtitle: "用于「帮我阅读 / 帮我引用 / 笔记重写 / 分类建议 / 好句摘抄」。翻译走单独 provider，不互相影响。" },
    translation: { group: "AI 调用",   label: "翻译模型",     subtitle: "划词翻译用的轻量 provider。默认本地 Ollama，零成本。" },
    ocr:         { group: "AI 调用",   label: "扫描件 OCR",   subtitle: "PDF 抽出的文字太少（< 触发阈值）时，自动用 OCR 引擎识别每页文字。默认 RapidOCR，模型已打包在 pip 包里，无需联网下载。" },
    vision:      { group: "AI 调用",   label: "视觉模型",     subtitle: "AI 问答附带 PDF 页面图片时走的视觉 provider。主模型可以是 DeepSeek 之类的文本模型，视觉单独走 Qwen-VL / GPT-4o / Claude。" },
    prompts:     { group: "AI 调用",   label: "提示词与模板", subtitle: "「整理新文献」时调用的提示词；笔记 Markdown 模板。" },
    easyscholar: { group: "文献数据", label: "期刊等级源",   subtitle: "EasyScholar 自动查询期刊等级。结果写入「期刊等级_自动」字段；你手填的「期刊等级_人工」永不被覆盖。" },
    journals:    { group: "文献数据", label: "追踪期刊库",   subtitle: "你关注的期刊清单。整理新文献时会自动匹配并打星 / 写「追踪期刊领域」标签。" },
    ui:          { group: "界面",     label: "面板与显示",   subtitle: "右侧 inspector 显示哪些 tab。" },
  };

  const NAV_ORDER = ["model", "translation", "ocr", "vision", "prompts", "easyscholar", "journals", "ui"];

  // ============================================================
  // 1. Styles
  // ============================================================
  function injectStyles() {
    if (document.getElementById("dc-settings-style")) return;
    const s = document.createElement("style");
    s.id = "dc-settings-style";
    s.textContent = `
      /* Modal frame */
      #settingsModal .modal-card {
        max-width: 1100px !important;
        width: min(96vw, 1100px) !important;
        height: min(86vh, 760px);
        padding: 0 !important;
        background: var(--dc-bg);
        border-radius: var(--dc-r-modal);
        box-shadow: var(--dc-shadow-pop);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      #settingsModal .modal-head {
        padding: 16px 22px;
        background: var(--dc-panel);
        border-bottom: 1px solid var(--dc-line);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 14px;
      }
      #settingsModal .modal-head h2 {
        margin: 0 0 2px 0;
        font-family: var(--dc-font-serif);
        font-size: var(--dc-fs-h1);
        color: var(--dc-text-strong);
      }
      #settingsModal .dc-settings-subtitle {
        font-size: var(--dc-fs-sm);
        color: var(--dc-muted);
        margin: 0;
      }
      #settingsModal .dc-settings-head-right {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      #settingsModal .dc-settings-search {
        border: 1px solid var(--dc-line);
        background: var(--dc-surface);
        border-radius: var(--dc-r-pill);
        padding: 4px 12px 4px 30px;
        font-size: var(--dc-fs-sm);
        width: 220px;
        background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23807a6f' stroke-width='1.5'><circle cx='7' cy='7' r='4'/><path d='M10 10l3 3'/></svg>");
        background-repeat: no-repeat;
        background-position: 9px center;
        background-size: 14px;
      }
      #settingsModal .dc-settings-search:focus {
        outline: none;
        border-color: var(--dc-accent);
        box-shadow: 0 0 0 3px var(--dc-accent-soft);
      }
      #settingsModal #closeSettingsBtn {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-pill);
        width: 30px;
        height: 30px;
        padding: 0;
        font-size: 0;
        color: var(--dc-muted);
        cursor: pointer;
        position: relative;
      }
      #settingsModal #closeSettingsBtn::before {
        content: "×";
        font-size: 17px;
        line-height: 1;
      }
      #settingsModal #closeSettingsBtn:hover {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
        border-color: var(--dc-accent);
      }

      /* Hide the original horizontal tabs row */
      #settingsModal #settingsTabs.dc-original-tabs { display: none !important; }

      /* Body layout: vertical sidebar + detail pane */
      #settingsModal .dc-settings-body {
        flex: 1;
        display: grid;
        grid-template-columns: 180px 1fr;
        min-height: 0;
        overflow: hidden;
      }
      .dc-settings-nav {
        background: var(--dc-panel);
        border-right: 1px solid var(--dc-line);
        padding: 16px 10px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dc-settings-nav-group {
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted-soft);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 10px 10px 4px;
        font-weight: var(--dc-fw-medium);
      }
      .dc-settings-nav-group:first-child { padding-top: 0; }
      .dc-settings-nav-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        font-size: var(--dc-fs-sm);
        color: var(--dc-muted);
        border-radius: var(--dc-r-button);
        cursor: pointer;
        border: none;
        background: transparent;
        text-align: left;
        width: 100%;
      }
      .dc-settings-nav-item:hover {
        background: var(--dc-panel-soft);
        color: var(--dc-text-strong);
      }
      .dc-settings-nav-item.active {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
        font-weight: var(--dc-fw-medium);
      }
      .dc-settings-nav-item .dc-nav-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--dc-muted-soft);
        flex-shrink: 0;
      }
      .dc-settings-nav-item.active .dc-nav-dot { background: var(--dc-accent); }

      .dc-settings-detail {
        padding: 22px 26px;
        overflow-y: auto;
        background: var(--dc-bg);
      }
      .dc-settings-detail h3 {
        margin: 0 0 4px 0;
        font-family: var(--dc-font-serif);
        font-size: var(--dc-fs-h1);
        color: var(--dc-text-strong);
      }
      .dc-settings-detail .dc-section-subtitle {
        margin: 0 0 16px 0;
        font-size: var(--dc-fs-sm);
        color: var(--dc-muted);
        line-height: 1.55;
        max-width: 640px;
      }

      /* Connection status card (only on model tab) */
      .dc-conn-card {
        border: 1px solid var(--dc-line);
        background: var(--dc-panel-soft);
        border-radius: var(--dc-r-card);
        padding: 14px 16px;
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 18px;
        max-width: 720px;
      }
      .dc-conn-icon {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--dc-accent);
        font-size: 18px;
        flex-shrink: 0;
      }
      .dc-conn-info { flex: 1; min-width: 0; }
      .dc-conn-status-row {
        font-size: var(--dc-fs-xs);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 3px;
      }
      .dc-conn-status-row .dc-conn-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--dc-ok);
      }
      .dc-conn-status-row.unknown .dc-conn-dot { background: var(--dc-muted-soft); }
      .dc-conn-status-row.error .dc-conn-dot { background: var(--dc-danger); }
      .dc-conn-status-row.testing .dc-conn-dot {
        background: var(--dc-accent);
        animation: dc-pulse 1.2s infinite;
      }
      .dc-conn-status-label {
        color: var(--dc-muted);
      }
      .dc-conn-title {
        font-size: var(--dc-fs-h2);
        font-weight: var(--dc-fw-medium);
        color: var(--dc-text-strong);
        line-height: 1.3;
      }
      .dc-conn-meta {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        margin-top: 2px;
      }
      .dc-conn-card .dc-btn-icon-text {
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        color: var(--dc-text);
        border-radius: var(--dc-r-pill);
        padding: 5px 12px;
        font-size: var(--dc-fs-xs);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dc-conn-card .dc-btn-icon-text:hover {
        border-color: var(--dc-accent);
        color: var(--dc-accent-strong);
      }
      .dc-conn-card .dc-btn-icon-text:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .dc-conn-card .dc-conn-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      /* Make the switch button visually primary so it's the obvious first action */
      .dc-conn-card #dcConnSwitchBtn {
        background: var(--dc-accent);
        color: #fff;
        border-color: var(--dc-accent);
      }
      .dc-conn-card #dcConnSwitchBtn:hover {
        background: var(--dc-accent-strong, var(--dc-accent));
        color: #fff;
      }

      /* Footer */
      .dc-settings-footer {
        padding: 12px 22px;
        border-top: 1px solid var(--dc-line);
        background: var(--dc-panel);
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .dc-settings-footer .dc-footer-state {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dc-settings-footer .dc-footer-state::before {
        content: "";
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--dc-muted-soft);
      }
      .dc-settings-footer .dc-footer-state.dirty::before { background: var(--dc-warn, #c98a3c); }
      .dc-settings-footer .dc-footer-state.dirty { color: var(--dc-warn, #c98a3c); }
      .dc-settings-footer .dc-footer-state.saving::before { background: var(--dc-accent, #cc785c); }
      .dc-settings-footer .dc-footer-state.saved::before { background: var(--dc-ok, #4f7d52); }
      .dc-settings-footer .dc-footer-state.saved { color: var(--dc-ok, #4f7d52); }
      .dc-settings-footer .dc-footer-state.error::before { background: var(--dc-danger, #a04545); }
      .dc-settings-footer .dc-footer-state.error { color: var(--dc-danger, #a04545); }
      .dc-settings-footer .dc-footer-spacer { flex: 1; }

      /* All settings-section contents inherit nice spacing inside detail pane */
      #settingsModal .settings-section { padding: 0; }
      #settingsModal .settings-section.hidden { display: none !important; }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  // 2. Restructure DOM
  // ============================================================
  let dirty = false;

  function mount() {
    const modal = document.getElementById("settingsModal");
    const card = modal?.querySelector(".modal-card");
    if (!modal || !card || card.dataset.dcSettingsMounted) return !!card;
    card.dataset.dcSettingsMounted = "1";

    // 1. Wrap original modal-head into our format
    const oldHead = card.querySelector(".modal-head");
    if (oldHead) {
      // Replace inner with our layout
      const h2 = oldHead.querySelector("h2");
      const closeBtn = oldHead.querySelector("#closeSettingsBtn");
      oldHead.innerHTML = "";
      const left = document.createElement("div");
      left.innerHTML = `<h2>设置</h2>`;
      const right = document.createElement("div");
      right.className = "dc-settings-head-right";
      const search = document.createElement("input");
      search.type = "search";
      search.id = "dcSettingsSearch";
      search.className = "dc-settings-search";
      search.placeholder = "搜设置·如 deepseek key";
      right.appendChild(search);
      if (closeBtn) right.appendChild(closeBtn);
      oldHead.appendChild(left);
      oldHead.appendChild(right);
    }

    // 2. Hide original horizontal tabs row
    const tabsRow = document.getElementById("settingsTabs");
    if (tabsRow) tabsRow.classList.add("dc-original-tabs");

    // 3. Build body: sidebar + detail
    const body = document.createElement("div");
    body.className = "dc-settings-body";
    const nav = document.createElement("aside");
    nav.className = "dc-settings-nav";
    nav.id = "dcSettingsNav";
    const detail = document.createElement("section");
    detail.className = "dc-settings-detail";
    detail.id = "dcSettingsDetail";

    // Move all existing #*SettingsSection into the detail pane, wrapped
    // with a header (title + subtitle) per nav item.
    NAV_ORDER.forEach((key) => {
      const sec = document.getElementById(`${key}SettingsSection`);
      if (!sec) return;
      const wrap = document.createElement("div");
      wrap.className = "dc-settings-section-wrap";
      wrap.dataset.section = key;
      wrap.style.display = "none"; // start hidden; nav will show one
      const header = document.createElement("div");
      const cfg = NAV[key];
      header.innerHTML = `
        <h3>${escapeHtml(cfg?.label || key)}</h3>
        <p class="dc-section-subtitle">${escapeHtml(cfg?.subtitle || "")}</p>
      `;
      wrap.appendChild(header);
      // Detach the existing section and append into wrap
      sec.classList.remove("hidden");
      sec.parentNode.removeChild(sec);
      wrap.appendChild(sec);
      detail.appendChild(wrap);
    });

    // 4. Build nav items grouped by section
    const groups = {};
    NAV_ORDER.forEach((key) => {
      const cfg = NAV[key];
      if (!cfg) return;
      groups[cfg.group] = groups[cfg.group] || [];
      groups[cfg.group].push(key);
    });
    Object.entries(groups).forEach(([groupName, keys]) => {
      const gHead = document.createElement("div");
      gHead.className = "dc-settings-nav-group";
      gHead.textContent = groupName;
      nav.appendChild(gHead);
      keys.forEach((key) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "dc-settings-nav-item";
        item.dataset.section = key;
        item.innerHTML = `<span class="dc-nav-dot"></span><span>${escapeHtml(NAV[key].label)}</span>`;
        item.addEventListener("click", () => activate(key));
        nav.appendChild(item);
      });
    });

    body.appendChild(nav);
    body.appendChild(detail);

    // Insert body between head and any footer (or as second child of card)
    if (oldHead) {
      oldHead.parentNode.insertBefore(body, oldHead.nextSibling);
    } else {
      card.appendChild(body);
    }

    // 5. Build footer
    const footer = document.createElement("div");
    footer.className = "dc-settings-footer";
    footer.innerHTML = `
      <span class="dc-footer-state" id="dcSettingsFooterState">未修改</span>
      <span class="dc-footer-spacer"></span>
      <button class="dc-btn" id="dcSettingsCancelBtn" type="button">取消</button>
      <button class="dc-btn dc-btn-primary" id="dcSettingsSaveBtn" type="button"
              title="保存当前 tab 的设置。不会自动测试 — 测试请用主模型卡片里的「重新测试」按钮">
        保存 ⌘S
      </button>
    `;
    card.appendChild(footer);
    document.getElementById("dcSettingsCancelBtn").addEventListener("click", () => {
      modal.classList.add("hidden");
    });
    document.getElementById("dcSettingsSaveBtn").addEventListener("click", saveAndTest);

    // 6. Inject 连接状态卡 into 主模型 section
    injectConnectionCard();

    // 7. Wire mark-dirty on any input change inside detail
    detail.addEventListener("input", () => setState("dirty"), true);
    detail.addEventListener("change", () => setState("dirty"), true);

    // 8. Search filter (very simple: hide nav items whose label or section
    //    text doesn't match)
    document.getElementById("dcSettingsSearch")?.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll(".dc-settings-nav-item").forEach((it) => {
        const k = it.dataset.section;
        const txt = (NAV[k]?.label + " " + NAV[k]?.subtitle).toLowerCase();
        it.style.display = !q || txt.includes(q) ? "" : "none";
      });
    });

    // 9. Cmd/Ctrl+S handler when modal is open
    document.addEventListener("keydown", (e) => {
      if (modal.classList.contains("hidden")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveAndTest();
      }
    });

    // Initial active: model
    activate("model");
    return true;
  }

  function injectConnectionCard() {
    const sec = document.getElementById("modelSettingsSection");
    if (!sec || sec.querySelector(".dc-conn-card")) return;
    // 删掉 phase5 注入的旧版「连接状态卡」(#connCard)，避免重复
    const phase5Card = document.getElementById("connCard") || sec.querySelector(".conn-card");
    if (phase5Card) phase5Card.remove();
    // 也防它后续再回来：观察一次，如果 phase5 又注入了就再移除
    new MutationObserver(() => {
      const dup = document.getElementById("connCard");
      if (dup) dup.remove();
    }).observe(sec, { childList: true });
    const card = document.createElement("div");
    card.className = "dc-conn-card";
    card.innerHTML = `
      <div class="dc-conn-icon">
        <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6">
          <circle cx="9" cy="9" r="6"/>
          <path d="M3 9h12M9 3a8 8 0 010 12M9 3a8 8 0 000 12"/>
        </svg>
      </div>
      <div class="dc-conn-info">
        <div class="dc-conn-status-row unknown">
          <span class="dc-conn-dot"></span>
          <span class="dc-conn-status-label">尚未测试</span>
        </div>
        <div class="dc-conn-title" id="dcConnTitle">—</div>
        <div class="dc-conn-meta" id="dcConnMeta">点右侧「重新测试」检查连接</div>
      </div>
      <div class="dc-conn-actions">
        <button class="dc-btn-icon-text" id="dcConnSwitchBtn" type="button"
                title="把当前选中的 provider tab + 已填字段保存到 settings.yaml，并刷新此卡片顶部的「provider · model」显示。不会自动 ping。">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 4h7l-2-2M10 8H3l2 2"/></svg>
          切换
        </button>
        <button class="dc-btn-icon-text" id="dcConnTestBtn" type="button"
                title="向当前已保存的 provider 发一个最小请求验证连通性">
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 6a4 4 0 014-4M10 6a4 4 0 01-4 4"/><path d="M2 6V3M10 6V9"/></svg>
          重新测试
        </button>
      </div>
    `;
    sec.insertBefore(card, sec.firstChild);
    document.getElementById("dcConnTestBtn").addEventListener("click", testConnection);
    document.getElementById("dcConnSwitchBtn").addEventListener("click", switchProvider);
    // Auto-refresh provider+model info from /api/config
    refreshConnInfo();
  }

  async function refreshConnInfo() {
    try {
      const data = await (await fetch("/api/config")).json();
      const title = document.getElementById("dcConnTitle");
      if (title) {
        const provider = data.provider || "—";
        const model = data.model || "—";
        title.textContent = `${provider} · ${model}`;
      }
    } catch (_) {}
  }

  async function testConnection() {
    const card = document.querySelector(".dc-conn-card");
    if (!card) return;
    const row = card.querySelector(".dc-conn-status-row");
    const label = row.querySelector(".dc-conn-status-label");
    const meta = document.getElementById("dcConnMeta");
    row.className = "dc-conn-status-row testing";
    label.textContent = "测试中…";
    meta.textContent = "正在向 provider 发一个 ping…";
    try {
      const r = await fetch("/api/llm/ping");
      const d = await r.json();
      if (d.ok) {
        row.className = "dc-conn-status-row";
        label.textContent = "连接正常";
        meta.textContent = `延迟 ${d.latency_ms} ms · ${d.provider} · ${d.model}`;
      } else {
        row.className = "dc-conn-status-row error";
        label.textContent = "连接失败";
        meta.textContent = d.error || "未知错误";
      }
    } catch (e) {
      row.className = "dc-conn-status-row error";
      label.textContent = "请求失败";
      meta.textContent = e.message;
    }
  }

  function activate(key) {
    document.querySelectorAll(".dc-settings-nav-item").forEach((it) => {
      it.classList.toggle("active", it.dataset.section === key);
    });
    document.querySelectorAll(".dc-settings-section-wrap").forEach((w) => {
      w.style.display = w.dataset.section === key ? "" : "none";
    });
    // For backward compat: still notify the original showSettingsTab if it
    // exists (some sub-tabs lazy-load content on first show)
    if (typeof window.showSettingsTab === "function") {
      try { window.showSettingsTab(key); } catch (_) {}
    }
    // Click the original (now hidden) tab to trigger its lazy-load
    const origTab = document.querySelector(`#settingsTabs button[data-settings-tab="${key}"]`);
    if (origTab) {
      // origTab.click() but it's display:none so won't visually flash
      origTab.click();
    }
    if (key === "model") refreshConnInfo();
  }

  // ── 页脚保存信号：5 个状态 ───────────────────────────────────────────
  //   pristine 未修改 · dirty 已修改·未保存 · saving 保存中…
  //   · saved 已保存 ✓ · error 保存失败
  // 保存按钮点下后进 saving，再盯住该 section 的状态文字真正落定成
  // saved / error —— 不再「点完就乐观地写回未修改」。
  let footerState = "pristine";
  const FOOTER_STATES = {
    pristine: { cls: "", text: "未修改" },
    dirty: { cls: "dirty", text: "已修改 · 未保存" },
    saving: { cls: "saving", text: "保存中…" },
    saved: { cls: "saved", text: "已保存 ✓" },
    error: { cls: "error", text: "保存失败" },
  };

  function setState(name, customText) {
    footerState = FOOTER_STATES[name] ? name : "pristine";
    dirty = footerState === "dirty";
    const el = document.getElementById("dcSettingsFooterState");
    if (!el) return;
    const s = FOOTER_STATES[footerState];
    el.className = "dc-footer-state " + s.cls;
    el.textContent = customText || s.text;
  }

  // 各 section 的「原生保存按钮」与「状态文字 span」
  const SAVE_BTN_ID = {
    model: "saveSettingsBtn",
    translation: "saveTranslationBtn",
    ocr: "saveOcrBtn",
    vision: "saveVisionBtn",
    prompts: "savePromptsBtn",
    easyscholar: "saveEasyscholarBtn",
    journals: "saveJournalsBtn",
    ui: "saveUiBtn",
  };
  const STATUS_EL_ID = {
    model: "settingsStatus",
    translation: "translationStatus",
    ocr: "ocrStatus",
    vision: "visionStatus",
    prompts: "promptsStatus",
    easyscholar: "easyscholarStatus",
    journals: "journalsStatus",
    ui: "uiSaveStatus",
  };

  // 点了保存后盯住该 section 的状态 span，落定成 saved / error。
  function observeSaveResult(statusId) {
    const statusEl = statusId ? document.getElementById(statusId) : null;
    let obs = null;
    let timer = null;
    let settled = false;
    const settle = (ok, msg) => {
      if (settled) return;
      settled = true;
      if (obs) obs.disconnect();
      if (timer) clearTimeout(timer);
      setState(ok ? "saved" : "error", ok ? "" : (msg ? "保存失败：" + msg : "保存失败"));
    };
    if (!statusEl) {
      // 该 section 没有状态 span —— 保存按钮已点，乐观按成功处理
      timer = setTimeout(() => settle(true), 600);
      return;
    }
    const check = () => {
      const t = (statusEl.textContent || "").trim();
      if (!t || t.includes("保存中")) return;        // 还在进行
      if (t.includes("已保存")) settle(true);
      else settle(false, t);                          // 其余非空文本视作错误
    };
    obs = new MutationObserver(check);
    obs.observe(statusEl, { childList: true, characterData: true, subtree: true });
    timer = setTimeout(() => settle(true), 6000);     // 兜底：本地写文件极快
    check();
  }

  function saveAndTest() {
    // 保存当前 section。不自动测试 —— 测试请用连接卡的「重新测试」按钮。
    const activeWrap = Array.from(document.querySelectorAll(".dc-settings-section-wrap"))
      .find((w) => w.style.display !== "none");
    const key = activeWrap?.dataset?.section;
    const btn = SAVE_BTN_ID[key] && document.getElementById(SAVE_BTN_ID[key]);
    if (!btn) return;
    const statusId = STATUS_EL_ID[key];
    // 清掉上一次保存留下的状态文字，避免被误判成本次结果
    const statusEl = statusId && document.getElementById(statusId);
    if (statusEl) statusEl.textContent = "";
    setState("saving");
    btn.click();
    observeSaveResult(statusId);
    // model tab：保存后刷新连接卡顶部的 provider/model 显示（不自动 ping）
    if (key === "model") {
      setTimeout(refreshConnInfo, 600);
    }
  }

  // 切换 button on the conn card: save the model section (which uses
  // state.activeProvider — already updated by clicking a provider tab) and
  // refresh the displayed provider/model. No ping.
  async function switchProvider() {
    const btn = document.getElementById("dcConnSwitchBtn");
    if (!btn) return;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "切换中…";
    try {
      const save = document.getElementById("saveSettingsBtn");
      if (save) save.click();
      // app.js's saveSettings is async; wait for it to finish its write+reload
      // cycle before refreshing the conn card. 800ms is a safe margin.
      await new Promise((r) => setTimeout(r, 800));
      await refreshConnInfo();
      // Reset the status row to "尚未测试" so the user knows they should ping
      // again — the previous test result was for the OLD provider.
      const row = document.querySelector(".dc-conn-card .dc-conn-status-row");
      const label = row?.querySelector(".dc-conn-status-label");
      const meta = document.getElementById("dcConnMeta");
      if (row) row.className = "dc-conn-status-row unknown";
      if (label) label.textContent = "尚未测试";
      if (meta) meta.textContent = "已切换 provider，点右侧「重新测试」检查连接";
      setState("saved");
      btn.textContent = "已切换 ✓";
      setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 1400);
    } catch (e) {
      btn.textContent = "切换失败";
      setTimeout(() => { btn.innerHTML = originalHTML; btn.disabled = false; }, 1400);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function boot() {
    injectStyles();
    if (!mount()) requestAnimationFrame(boot);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
