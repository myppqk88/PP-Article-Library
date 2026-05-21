/* ============================================================
 * 文献工作台 — Design patch: 分类 tab (右栏 #metaPanel)
 *
 * Strategy: app.js already wires every form field correctly. This patch
 *   - re-skins existing sections to match the mockup
 *   - injects a breadcrumb-chip display showing the confirmed
 *     (一级 › 二级 › 三级) path
 *   - adds an «AI 重译» button next to 中文标题
 *   - converts the SSCI/SCI/UTD/FT50/ABS checkboxes to chip toggles
 *   - adds a sticky save bar at the bottom with «自动保存中» indicator
 *
 * The hidden underlying form inputs (#flagSSCI etc.) remain — chip clicks
 * just flip them and fire change events so app.js's save flow still works.
 * ============================================================ */

(function () {
  "use strict";

  const FLAGS = [
    { id: "flagSSCI", label: "SSCI" },
    { id: "flagSCI", label: "SCI" },
    { id: "flagUTD", label: "UTD24" },
    { id: "flagFT50", label: "FT50" },
    { id: "flagABS", label: "ABS" },
  ];

  function injectStyles() {
    if (document.getElementById("dc-meta-style")) return;
    const s = document.createElement("style");
    s.id = "dc-meta-style";
    s.textContent = `
      /* 紧凑布局：减少段间距和 padding */
      #metaPanel { padding-top: 8px; padding-bottom: 0; }
      #metaPanel .meta-section {
        margin-bottom: 10px;
      }
      #metaPanel .meta-section-head {
        font-size: var(--dc-fs-xs);
        font-weight: var(--dc-fw-medium);
        color: var(--dc-muted);
        letter-spacing: 0.04em;
        margin-bottom: 5px;
        padding-bottom: 2px;
        border-bottom: 1px solid var(--dc-line-soft);
      }
      #metaPanel .meta-field { margin-bottom: 6px; }
      #metaPanel .meta-field > label {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        margin-bottom: 2px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #metaPanel .meta-field > input,
      #metaPanel .meta-field > textarea,
      #metaPanel .meta-field > select {
        width: 100%;
        padding: 5px 9px;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-input);
        background: var(--dc-surface);
        color: var(--dc-text);
        font-size: var(--dc-fs-body);
        font-family: var(--dc-font-sans);
      }
      /* 把「状态」section 的两栏挤紧 */
      #metaPanel .meta-row-2 {
        gap: 12px !important;
      }
      /* 重要性 + 阅读状态 一行排开 */
      #metaPanel #importanceStars { gap: 1px; }
      #metaPanel #importanceStars .star {
        font-size: 16px;
        padding: 0;
      }
      #metaPanel .meta-field > input:focus,
      #metaPanel .meta-field > textarea:focus {
        outline: none;
        border-color: var(--dc-accent);
        box-shadow: 0 0 0 3px var(--dc-accent-soft);
      }

      /* AI 重译 button next to 中文标题 */
      .dc-ai-retrans-btn {
        background: var(--dc-accent-soft);
        color: var(--dc-accent-strong);
        border: 1px solid var(--dc-accent-soft);
        border-radius: var(--dc-r-pill);
        padding: 1px 9px;
        font-size: var(--dc-fs-xxs);
        font-weight: var(--dc-fw-medium);
        cursor: pointer;
        display: inline-flex;
        gap: 3px;
        align-items: center;
      }
      .dc-ai-retrans-btn:hover {
        background: var(--dc-accent);
        color: var(--dc-accent-ink);
        border-color: var(--dc-accent);
      }
      .dc-ai-retrans-btn::before {
        content: "★";
        font-size: 11px;
      }

      /* 分类路径 — breadcrumb display card */
      .dc-meta-cat-card {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-card);
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dc-meta-cat-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .dc-meta-cat-confirmed-label {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        font-weight: var(--dc-fw-medium);
      }
      .dc-meta-cat-adjust {
        font-size: var(--dc-fs-xs);
        color: var(--dc-accent-strong);
        background: transparent;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-pill);
        padding: 2px 10px;
        cursor: pointer;
      }
      .dc-meta-cat-adjust:hover { background: var(--dc-accent-tint); border-color: var(--dc-accent); }
      .dc-meta-cat-rows {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dc-meta-cat-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
      }
      .dc-meta-cat-empty {
        font-size: var(--dc-fs-sm);
        color: var(--dc-muted-soft);
        font-style: italic;
        padding: 4px 0;
      }
      .dc-meta-cat-ai-row {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
      }
      .dc-meta-cat-ai-link {
        color: var(--dc-accent-strong);
        text-decoration: underline;
        cursor: pointer;
        background: none;
        border: none;
        font-size: inherit;
        padding: 0;
      }
      .dc-meta-cat-ai-link::before {
        content: "AI";
        background: var(--dc-accent-soft);
        color: var(--dc-accent-strong);
        font-size: var(--dc-fs-xxs);
        padding: 1px 5px;
        border-radius: 3px;
        margin-right: 4px;
        text-decoration: none;
      }
      .dc-meta-cat-ai-hint {
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted-soft);
      }

      /* Hide native classification box — we built our own */
      #metaPanel #classificationBox.dc-hidden-by-design { display: none !important; }

      /* Status — stars + seg */
      #metaPanel .stars { display: inline-flex; gap: 2px; align-items: center; }
      #metaPanel .stars .star {
        background: transparent; border: none; cursor: pointer;
        font-size: 18px; color: var(--dc-muted-soft); padding: 0 1px;
        line-height: 1; transition: color 0.1s;
      }
      #metaPanel .stars .star.on,
      #metaPanel .stars .star.hover-on { color: var(--dc-accent); }
      #metaPanel .stars .star-meta {
        margin-left: 6px;
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
      }

      #metaPanel .status-seg {
        display: inline-flex;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-pill);
        background: var(--dc-panel-soft);
        padding: 2px;
        gap: 1px;
      }
      #metaPanel .status-seg button {
        border: none;
        background: transparent;
        padding: 3px 9px;
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        cursor: pointer;
        border-radius: calc(var(--dc-r-pill) - 2px);
        white-space: nowrap;
      }
      #metaPanel .status-seg button:hover { color: var(--dc-text-strong); }
      #metaPanel .status-seg button.active {
        background: var(--dc-accent);
        color: var(--dc-accent-ink);
        font-weight: var(--dc-fw-medium);
      }

      /* Journal rank: merged display + manual override */
      .dc-meta-rank-merged {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 10px;
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-input);
      }
      .dc-meta-rank-merged-label {
        font-size: var(--dc-fs-xxs);
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        color: var(--dc-muted);
        padding: 2px 7px;
        border-radius: var(--dc-r-pill);
        white-space: nowrap;
      }
      .dc-meta-rank-merged-source {
        flex-basis: 100%;
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted-soft);
      }

      /* 领域标识 chip toggles (replace checkboxes) */
      .dc-meta-flag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .dc-meta-flag {
        border: 1px solid var(--dc-line);
        background: var(--dc-panel-soft);
        color: var(--dc-muted);
        border-radius: var(--dc-r-pill);
        padding: 2px 10px;
        font-size: var(--dc-fs-xs);
        font-weight: var(--dc-fw-medium);
        cursor: pointer;
        white-space: nowrap;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dc-meta-flag:hover { border-color: var(--dc-accent); color: var(--dc-text); }
      .dc-meta-flag.on {
        background: var(--dc-accent);
        border-color: var(--dc-accent);
        color: var(--dc-accent-ink);
      }
      .dc-meta-flag.on::before {
        content: "✓";
        font-size: 11px;
      }
      /* Hide the original flag-grid (checkboxes) */
      #metaPanel .flag-grid { display: none !important; }

      /* Sticky bottom save bar */
      .dc-meta-save-bar {
        position: sticky;
        bottom: 0;
        margin: 10px -14px 0;
        padding: 8px 14px;
        background: var(--dc-panel);
        border-top: 1px solid var(--dc-line);
        display: flex;
        align-items: center;
        gap: 10px;
        z-index: 5;
      }
      .dc-meta-save-bar .dc-saving-state {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dc-meta-save-bar .dc-saving-state.saving::before {
        content: "";
        width: 7px; height: 7px;
        border-radius: 50%;
        background: var(--dc-ok);
        animation: dc-pulse 1.4s infinite;
      }
      .dc-meta-save-bar .dc-saving-state.saved::before {
        content: "";
        width: 7px; height: 7px;
        border-radius: 50%;
        background: var(--dc-ok);
      }
      .dc-meta-save-bar .dc-saving-state.error::before {
        content: "";
        width: 7px; height: 7px;
        border-radius: 50%;
        background: var(--dc-danger);
      }
      @keyframes dc-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      .dc-meta-save-bar-spacer { flex: 1; }

      /* Hide the inline save button (we have sticky one) */
      #metaPanel #saveMetaBtn.dc-hidden { display: none !important; }
      #metaPanel #metaSaveStatus.dc-hidden { display: none !important; }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  // Mount: insert breadcrumb card + flag chips + save bar
  // ============================================================
  function mount() {
    const panel = document.getElementById("metaPanel");
    if (!panel || panel.dataset.dcMounted) return !!panel;
    panel.dataset.dcMounted = "1";

    // --- 1. Replace 分类路径 section's body with breadcrumb card ---
    const oldCatBox = document.getElementById("classificationBox");
    if (oldCatBox) {
      oldCatBox.classList.add("dc-hidden-by-design");
      const card = document.createElement("div");
      card.className = "dc-meta-cat-card";
      card.id = "dcMetaCatCard";
      card.innerHTML = `
        <div class="dc-meta-cat-head">
          <span class="dc-meta-cat-confirmed-label">已确认</span>
          <button class="dc-meta-cat-adjust" id="dcMetaCatAdjust" type="button">✎ 调整…</button>
        </div>
        <div class="dc-meta-cat-rows" id="dcMetaCatRows">
          <div class="dc-meta-cat-empty">尚未确认分类，点「调整」选择</div>
        </div>
        <div class="dc-meta-cat-ai-row hidden" id="dcMetaCatAiRow">
          <span class="dc-meta-cat-ai-hint">AI 建议补充：</span>
          <button class="dc-meta-cat-ai-link" id="dcMetaCatAiLink" type="button">—</button>
          <span class="dc-meta-cat-ai-hint">（点击采纳）</span>
        </div>
      `;
      oldCatBox.parentNode.insertBefore(card, oldCatBox.nextSibling);

      // Wire 调整 button → open existing category modal
      document.getElementById("dcMetaCatAdjust").addEventListener("click", () => {
        oldCatBox.click();
      });
    }

    // --- 2. Replace flag-grid checkboxes with chip toggles ---
    const flagGrid = document.querySelector("#metaPanel .flag-grid");
    if (flagGrid) {
      const chipRow = document.createElement("div");
      chipRow.className = "dc-meta-flag-row";
      chipRow.id = "dcMetaFlagRow";
      chipRow.innerHTML = FLAGS.map(
        (f) => `<button class="dc-meta-flag" type="button" data-flag-id="${f.id}">${f.label}</button>`
      ).join("");
      flagGrid.parentNode.insertBefore(chipRow, flagGrid.nextSibling);

      // Wire each chip to toggle the underlying checkbox
      chipRow.querySelectorAll(".dc-meta-flag").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.flagId;
          const cb = document.getElementById(id);
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
            btn.classList.toggle("on", cb.checked);
          }
        });
      });
    }

    // --- 3. Sticky save bar ---
    const oldSaveBtn = document.getElementById("saveMetaBtn");
    const oldStatus = document.getElementById("metaSaveStatus");
    if (oldSaveBtn) oldSaveBtn.classList.add("dc-hidden");
    if (oldStatus) oldStatus.classList.add("dc-hidden");
    const bar = document.createElement("div");
    bar.className = "dc-meta-save-bar";
    bar.innerHTML = `
      <span class="dc-saving-state saved" id="dcMetaSavingState">已同步</span>
      <span class="dc-meta-save-bar-spacer"></span>
      <button class="dc-btn dc-btn-primary" id="dcMetaSaveBtn" type="button">手动保存</button>
    `;
    const form = panel.querySelector(".meta-panel-form") || panel;
    form.appendChild(bar);
    document.getElementById("dcMetaSaveBtn").addEventListener("click", () => {
      if (oldSaveBtn) oldSaveBtn.click();
    });

    return true;
  }

  // ============================================================
  // Sync: pull current paper's category info into the breadcrumb card
  // ============================================================
  function shortenChip(s) {
    s = String(s || "").trim();
    // Drop "C01 " etc. prefix for visual brevity (still readable)
    return s.replace(/^[Cc]\d+\s+/, "");
  }

  function syncCategoryBreadcrumb() {
    const rows = document.getElementById("dcMetaCatRows");
    const aiRow = document.getElementById("dcMetaCatAiRow");
    const aiLink = document.getElementById("dcMetaCatAiLink");
    if (!rows) return;

    // Read the current selected paper from app.js's classification summary
    const summary = (document.getElementById("classificationSummary")?.textContent || "").trim();
    // Pull confirmed parts. The summary is like "一级；二级；三级" (joined by ；)
    // Also may include AI suggestions in parens.
    const aiPrefix = "AI建议：";
    let confirmed = summary;
    let aiSuggestion = "";
    if (summary.startsWith(aiPrefix)) {
      aiSuggestion = summary.slice(aiPrefix.length);
      confirmed = "";
    }
    if (!confirmed || confirmed === "未设置") {
      rows.innerHTML = '<div class="dc-meta-cat-empty">尚未确认分类，点「调整」选择</div>';
    } else {
      const parts = confirmed.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) {
        rows.innerHTML = '<div class="dc-meta-cat-empty">尚未确认分类，点「调整」选择</div>';
      } else {
        // Show as one breadcrumb row of chips (could be multiple chains in
        // theory; for simplicity flatten as single chain)
        const html =
          '<div class="dc-meta-cat-row">' +
          parts
            .map((p, i) => {
              const chip = `<span class="dc-chip dc-chip-accent">${escapeHtml(shortenChip(p))}</span>`;
              return i < parts.length - 1
                ? chip + '<span class="dc-breadcrumb-sep">›</span>'
                : chip;
            })
            .join("") +
          "</div>";
        rows.innerHTML = html;
      }
    }

    // AI suggestion row
    if (aiSuggestion) {
      const aiParts = aiSuggestion.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
      const display = aiParts[0] ? shortenChip(aiParts[0]) : "—";
      aiLink.textContent = display;
      aiRow.classList.remove("hidden");
      aiLink.onclick = () => {
        // Open the category modal — user can take the suggestion there
        document.getElementById("classificationBox")?.click();
      };
    } else {
      aiRow.classList.add("hidden");
    }
  }

  function syncFlagChips() {
    const chips = document.querySelectorAll("#dcMetaFlagRow .dc-meta-flag");
    chips.forEach((btn) => {
      const id = btn.dataset.flagId;
      const cb = document.getElementById(id);
      if (cb) btn.classList.toggle("on", !!cb.checked);
    });
  }

  function setSavingState(state, msg) {
    const el = document.getElementById("dcMetaSavingState");
    if (!el) return;
    el.classList.remove("saving", "saved", "error");
    el.classList.add(state);
    el.textContent = msg || ({ saving: "保存中…", saved: "已同步", error: "保存失败" })[state] || "";
  }

  // Observe app.js's #metaSaveStatus text — it sets "已同步到总表" / 错误
  function watchSaveStatus() {
    const status = document.getElementById("metaSaveStatus");
    if (!status) return;
    const obs = new MutationObserver(() => {
      const t = status.textContent || "";
      if (!t) return;
      if (t.includes("失败") || t.includes("错误") || t.includes("error")) {
        setSavingState("error", t.slice(0, 30));
      } else if (t.includes("中") || t.includes("ing")) {
        setSavingState("saving");
      } else {
        setSavingState("saved", "已同步");
      }
    });
    obs.observe(status, { childList: true, characterData: true, subtree: true });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ============================================================
  // Hook paper switches
  // ============================================================
  function refresh() {
    syncCategoryBreadcrumb();
    syncFlagChips();
  }

  // Watch the existing classificationSummary text for changes
  function watchClassification() {
    const summary = document.getElementById("classificationSummary");
    if (!summary) return;
    const obs = new MutationObserver(refresh);
    obs.observe(summary, { childList: true, characterData: true, subtree: true });
  }

  // Watch flag checkboxes (in case selectPaper rewrites them)
  function watchFlags() {
    FLAGS.forEach((f) => {
      const cb = document.getElementById(f.id);
      if (cb) {
        cb.addEventListener("change", syncFlagChips);
      }
    });
    // Also a periodic sync in case external code mutates without firing change
    let last = "";
    setInterval(() => {
      const sig = FLAGS.map((f) => document.getElementById(f.id)?.checked ? "1" : "0").join("");
      if (sig !== last) {
        last = sig;
        syncFlagChips();
      }
    }, 800);
  }

  function boot() {
    injectStyles();
    if (mount()) {
      refresh();
      watchClassification();
      watchSaveStatus();
      watchFlags();
    } else {
      requestAnimationFrame(boot);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Add «AI 重译» button next to 中文标题 label (only adds once)
  function addAiRetransButton() {
    const titleZh = document.getElementById("titleZh");
    if (!titleZh) return;
    const label = titleZh.parentElement.querySelector("label");
    if (!label || label.querySelector(".dc-ai-retrans-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dc-ai-retrans-btn";
    btn.textContent = "AI 重译";
    btn.title = "用 AI 把英文标题翻译成中文（暂未启用 — 占位）";
    btn.addEventListener("click", () => {
      window.toast?.("AI 重译功能待接入。当前需要手动填写中文标题。", "info");
    });
    label.appendChild(btn);
  }
  setTimeout(addAiRetransButton, 200);
})();
