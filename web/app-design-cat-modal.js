/* ============================================================
 * 文献工作台 — Design patch: 分类弹窗 (3-column modal restyle)
 *
 * The DOM (#categoryModalV2) is already built by phase5/app.js. This
 * patch only:
 *   1. Injects design-token-aligned CSS to repaint the 3-column layout,
 *      breadcrumb, AI badges, inline add inputs, footer bar.
 *   2. Inserts a「编辑分类体系...」secondary button into the footer (the
 *      design shows it; nobody had created it yet).
 *   3. Tightens column row layout: checkbox · name · count(right) ·
 *      hover ✎ × actions.
 *
 * No backend changes. No behavior changes — purely visual.
 * ============================================================ */

(function () {
  "use strict";

  function injectStyles() {
    if (document.getElementById("dc-catmodal-style")) return;
    const s = document.createElement("style");
    s.id = "dc-catmodal-style";
    s.textContent = `
      /* ---- Modal frame ---- */
      #categoryModalV2 .modal-card {
        max-width: 1100px !important;
        width: min(96vw, 1100px) !important;
        background: var(--dc-bg);
        border-radius: var(--dc-r-modal);
        box-shadow: var(--dc-shadow-pop);
        padding: 0;
        overflow: hidden;
      }
      #categoryModalV2 .modal-head {
        padding: 18px 22px 14px;
        border-bottom: 1px solid var(--dc-line);
        background: var(--dc-panel);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      #categoryModalV2 .modal-head h2 {
        margin: 0;
        font-family: var(--dc-font-serif);
        font-size: var(--dc-fs-h1);
        color: var(--dc-text-strong);
        line-height: 1.2;
      }
      #categoryModalV2 #categoryV2Subtitle {
        display: block;
        margin-top: 4px;
        color: var(--dc-muted);
        font-size: var(--dc-fs-sm);
        max-width: 720px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #categoryModalV2 #closeCategoryV2Btn {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-pill);
        width: 30px;
        height: 30px;
        padding: 0;
        font-size: 16px;
        color: var(--dc-muted);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #categoryModalV2 #closeCategoryV2Btn:hover {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
        border-color: var(--dc-accent);
      }
      #categoryModalV2 #closeCategoryV2Btn::before {
        content: "×";
      }
      #categoryModalV2 #closeCategoryV2Btn > * { display: none; }

      /* ---- 已选 breadcrumb row ---- */
      #categoryModalV2 .cat-picker { padding: 0; background: var(--dc-bg); }
      #categoryModalV2 #catPathRow {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 22px;
        background: var(--dc-panel-soft);
        border-bottom: 1px solid var(--dc-line);
        flex-wrap: wrap;
      }
      #categoryModalV2 #catPathRow .path-label {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        padding: 2px 9px;
        border-radius: var(--dc-r-pill);
        font-weight: var(--dc-fw-medium);
      }
      #categoryModalV2 #catPathRow .spacer { flex: 1; }
      #categoryModalV2 #catPathRow #catPathChips .dc-chip,
      #categoryModalV2 #catPathRow #catPathChips .path-chip {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
        border: 1px solid var(--dc-accent-soft);
        font-size: var(--dc-fs-xs);
        padding: 3px 11px;
        border-radius: var(--dc-r-pill);
        font-weight: var(--dc-fw-medium);
      }
      #categoryModalV2 #catPathRow .path-sep {
        color: var(--dc-muted-soft);
        font-size: var(--dc-fs-sm);
        user-select: none;
      }
      #categoryModalV2 #catPathRow.empty {
        opacity: 0.6;
      }
      #categoryModalV2 #catPathRow.empty::after {
        content: "尚未选择任何分类";
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted-soft);
        font-style: italic;
      }
      #categoryModalV2 #catClearLink {
        font-size: var(--dc-fs-xs);
        color: var(--dc-accent-strong);
        text-decoration: none;
        cursor: pointer;
        padding: 3px 10px;
        border-radius: var(--dc-r-pill);
      }
      #categoryModalV2 #catClearLink:hover {
        background: var(--dc-accent-tint);
        text-decoration: underline;
      }

      /* ---- 3-column body ---- */
      #categoryModalV2 .cat-cols {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 14px;
        padding: 18px 22px 14px;
      }
      #categoryModalV2 .cat-col {
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-card);
        display: flex;
        flex-direction: column;
        min-height: 380px;
      }
      #categoryModalV2 .cat-col-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--dc-line-soft);
        font-size: var(--dc-fs-xs);
        background: var(--dc-panel-soft);
        border-radius: var(--dc-r-card) var(--dc-r-card) 0 0;
      }
      #categoryModalV2 .cat-col-head > span:first-child {
        font-weight: var(--dc-fw-medium);
        color: var(--dc-text-strong);
      }
      #categoryModalV2 .cat-col-head .col-tag {
        color: var(--dc-muted);
      }
      #categoryModalV2 .cat-col-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0;
        min-height: 280px;
        max-height: 60vh;
      }
      #categoryModalV2 .cat-col-add {
        display: flex;
        gap: 4px;
        padding: 8px 10px;
        border-top: 1px solid var(--dc-line-soft);
        background: var(--dc-panel-soft);
        border-radius: 0 0 var(--dc-r-card) var(--dc-r-card);
      }
      #categoryModalV2 .cat-col-add input {
        flex: 1;
        border: 1px solid var(--dc-line);
        background: var(--dc-surface);
        border-radius: var(--dc-r-input);
        padding: 5px 9px;
        font-size: var(--dc-fs-xs);
        outline: none;
      }
      #categoryModalV2 .cat-col-add input:focus {
        border-color: var(--dc-accent);
        box-shadow: 0 0 0 2px var(--dc-accent-soft);
      }
      #categoryModalV2 .cat-col-add button {
        border: 1px solid var(--dc-accent);
        background: var(--dc-accent);
        color: var(--dc-accent-ink);
        border-radius: var(--dc-r-input);
        width: 28px;
        height: 28px;
        cursor: pointer;
        font-size: 14px;
        padding: 0;
      }
      #categoryModalV2 .cat-col-add button:hover {
        background: var(--dc-accent-strong);
      }

      /* ---- Each row in a column ---- */
      #categoryModalV2 .cat-row,
      #categoryModalV2 .cat-col-list > div {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        cursor: pointer;
        font-size: var(--dc-fs-sm);
        color: var(--dc-text);
        border-bottom: 1px solid transparent;
        transition: background 0.1s;
        position: relative;
      }
      #categoryModalV2 .cat-row:hover,
      #categoryModalV2 .cat-col-list > div:hover {
        background: var(--dc-accent-tint);
      }
      #categoryModalV2 .cat-row.focused,
      #categoryModalV2 .cat-col-list > div.focused,
      #categoryModalV2 .cat-col-list > div.active,
      #categoryModalV2 .cat-col-list > div.selected {
        background: var(--dc-accent-tint);
      }
      #categoryModalV2 .cat-row input[type="checkbox"],
      #categoryModalV2 .cat-col-list input[type="checkbox"] {
        accent-color: var(--dc-accent);
        cursor: pointer;
        flex-shrink: 0;
      }
      #categoryModalV2 .cat-row-name,
      #categoryModalV2 .cat-col-list .name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #categoryModalV2 .cat-row-count,
      #categoryModalV2 .cat-col-list .count {
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted);
        margin-left: auto;
        flex-shrink: 0;
        font-family: var(--dc-font-mono);
      }
      #categoryModalV2 .cat-row.checked,
      #categoryModalV2 .cat-col-list > div.checked {
        background: var(--dc-accent-tint);
      }
      #categoryModalV2 .cat-row.checked .cat-row-name,
      #categoryModalV2 .cat-col-list > div.checked .name {
        font-weight: var(--dc-fw-medium);
        color: var(--dc-text-strong);
      }

      /* AI 建议 mini badge inside rows */
      #categoryModalV2 .cat-row-ai-badge,
      #categoryModalV2 .ai-badge {
        background: var(--dc-accent-soft);
        color: var(--dc-accent-strong);
        font-size: var(--dc-fs-xxs);
        padding: 1px 6px;
        border-radius: var(--dc-r-pill);
        margin-right: 4px;
        font-weight: var(--dc-fw-medium);
      }
      #categoryModalV2 .cat-row-ai-badge::before,
      #categoryModalV2 .ai-badge::before {
        content: "AI";
      }
      #categoryModalV2 .cat-row-ai-badge,
      #categoryModalV2 .ai-badge { font-size: 0; }
      #categoryModalV2 .cat-row-ai-badge::before,
      #categoryModalV2 .ai-badge::before { font-size: var(--dc-fs-xxs); }

      /* Hover row actions */
      #categoryModalV2 .cat-row-actions,
      #categoryModalV2 .cat-col-list > div .row-actions {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        display: flex;
        gap: 2px;
        opacity: 0;
        transition: opacity 0.1s;
        background: var(--dc-accent-tint);
        padding: 0 4px;
        border-radius: var(--dc-r-button);
      }
      #categoryModalV2 .cat-row:hover .cat-row-actions,
      #categoryModalV2 .cat-col-list > div:hover .row-actions {
        opacity: 1;
      }
      #categoryModalV2 .cat-row-actions button,
      #categoryModalV2 .cat-col-list .row-actions button {
        border: none;
        background: transparent;
        color: var(--dc-muted);
        font-size: 11px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 3px;
      }
      #categoryModalV2 .cat-row-actions button:hover,
      #categoryModalV2 .cat-col-list .row-actions button:hover {
        color: var(--dc-accent-strong);
        background: var(--dc-surface);
      }

      /* ---- Footer ---- */
      #categoryModalV2 .cat-foot {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 22px;
        background: var(--dc-panel);
        border-top: 1px solid var(--dc-line);
        flex-wrap: wrap;
      }
      #categoryModalV2 .cat-foot .foot-hint {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
      }
      #categoryModalV2 .cat-foot .spacer { flex: 1; }
      #categoryModalV2 #catSaveStatus { font-size: var(--dc-fs-xs); }
      #categoryModalV2 #catCancelBtn,
      #categoryModalV2 #catEditTreeBtn {
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        color: var(--dc-muted);
        font-size: var(--dc-fs-sm);
        padding: 7px 14px;
        border-radius: var(--dc-r-button);
        cursor: pointer;
      }
      #categoryModalV2 #catCancelBtn:hover,
      #categoryModalV2 #catEditTreeBtn:hover {
        color: var(--dc-text-strong);
        border-color: var(--dc-accent);
      }
      #categoryModalV2 #catApplyBtn {
        background: var(--dc-accent);
        border: 1px solid var(--dc-accent);
        color: var(--dc-accent-ink);
        font-size: var(--dc-fs-sm);
        font-weight: var(--dc-fw-medium);
        padding: 7px 18px;
        border-radius: var(--dc-r-button);
        cursor: pointer;
      }
      #categoryModalV2 #catApplyBtn:hover {
        background: var(--dc-accent-strong);
        border-color: var(--dc-accent-strong);
      }
    `;
    document.head.appendChild(s);
  }

  // Inject the «编辑分类体系...» button into the footer if not present
  function injectEditTreeBtn() {
    const modal = document.getElementById("categoryModalV2");
    if (!modal || document.getElementById("catEditTreeBtn")) return;
    const cancelBtn = document.getElementById("catCancelBtn");
    if (!cancelBtn) return;
    const btn = document.createElement("button");
    btn.id = "catEditTreeBtn";
    btn.type = "button";
    btn.textContent = "编辑分类体系…";
    btn.title = "打开旧版的「分类管理」窗口，可以新建/重命名/删除一级分类";
    btn.addEventListener("click", () => {
      // Close this modal and open the legacy category-tree management modal
      modal.classList.add("hidden");
      const legacyOpen = document.getElementById("manageCategoryTreeBtn") ||
        document.getElementById("editCategoryTreeBtn") ||
        document.getElementById("openCategoryModalBtn");
      if (legacyOpen) {
        legacyOpen.click();
      } else {
        // Fallback: open settings → category management (if available)
        document.getElementById("settingsBtn")?.click();
      }
    });
    cancelBtn.parentNode.insertBefore(btn, cancelBtn);
  }

  function boot() {
    injectStyles();
    injectEditTreeBtn();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
