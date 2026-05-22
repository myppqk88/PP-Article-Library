/* ============================================================================
 * 设计优化 · 第 2 批 —— 阅读区头部压缩。
 *
 * 之前阅读区头部有 5 行 chrome 压在 PDF 之上（标题 / 作者行 / 期刊行 / rank 行
 * / toolbar 横条 ≈ 140px）。本补丁：
 *   1. 作者 · 年 · 期刊 · rank chips  合并成一行 flow
 *   2. 刷新等级 / 新窗口 / 删除  收进一个「⋯」溢出菜单（帮我阅读保持外露）
 *   3. 去掉永久 toolbar 横条；翻译按钮并入操作行，⌘C 提示去掉（按钮有 tooltip）
 * 结果：reader chrome ≈ 140px → ≈ 70px，PDF 多出近一屏 8% 阅读空间。
 *
 * 不改任何按钮的 id / 事件 —— 溢出菜单项只是代理 .click() 原按钮，原按钮
 * 隐藏但保留，所以 app.js 的 wiring 完全不受影响。
 * ========================================================================== */

(() => {
  const log = (...a) => console.log("[reader-compact]", ...a);

  // ---------------------------------------------------------- styles
  const css = `
    /* 1. 三行 meta 合并成一行 flow ------------------------------------ */
    .reader-head #paperMeta,
    .reader-head #paperVenueLine {
      display: inline;
    }
    .reader-head #paperRankLine {
      display: inline-flex;
      gap: 4px;
      vertical-align: middle;
    }
    /* 用 · 分隔，空段不显示分隔符 */
    .reader-head #paperVenueLine:not(:empty)::before,
    .reader-head #paperRankLine:not(:empty)::before {
      content: " · ";
      color: var(--dc-muted-soft, #b1aa9d);
    }
    /* 让标题 + 这一行 meta 之间间距收紧 */
    .reader-head h1 { margin-bottom: 4px; }
    .reader-head #paperMeta { margin: 0; }

    /* 2. 操作行紧凑 + 溢出菜单 ---------------------------------------- */
    .reader-actions { align-items: center; gap: 6px; }
    /* 隐藏被收进菜单的原按钮（保留在 DOM 里，事件不丢） */
    #refreshRankBtn.dc-tucked,
    #openPdfLink.dc-tucked,
    #deletePaperBtn.dc-tucked { display: none !important; }

    .dc-reader-more {
      width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--dc-line, #e6e1d4);
      border-radius: var(--dc-r-button, 6px);
      background: transparent;
      color: var(--dc-muted, #807a6f);
      cursor: pointer;
      font-size: 16px; line-height: 1;
      padding: 0;
    }
    .dc-reader-more:hover { background: var(--dc-panel-soft, #f5f3eb); border-color: var(--dc-accent, #cc785c); }

    .dc-reader-menu {
      position: fixed; z-index: 200;
      min-width: 180px;
      background: var(--dc-panel, #fcfbf7);
      border: 1px solid var(--dc-line, #e6e1d4);
      border-radius: var(--dc-r-card, 10px);
      box-shadow: var(--dc-shadow-pop, 0 16px 40px -10px rgba(60,50,40,0.22));
      padding: 5px;
      display: none;
    }
    .dc-reader-menu.open { display: block; }
    .dc-reader-menu button {
      display: block; width: 100%; text-align: left;
      border: none; background: transparent;
      padding: 7px 10px; border-radius: 6px;
      font-size: 12.5px; color: var(--dc-text, #2c2a25);
      cursor: pointer; white-space: nowrap;
    }
    .dc-reader-menu button:hover { background: var(--dc-panel-soft, #f5f3eb); }
    .dc-reader-menu button.danger { color: var(--dc-danger, #a04545); }
    .dc-reader-menu button:disabled { opacity: 0.4; cursor: not-allowed; }

    /* 3. 去掉永久 toolbar 横条 ---------------------------------------- */
    .reader-toolbar { display: none !important; }
    /* 翻译按钮并入操作行后的样式（次按钮观感） */
    #translateClipboardBtn.dc-in-actions {
      font-size: 12px; padding: 5px 11px;
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-reader-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---------------------------------------------------------- build
  function build() {
    const actions = document.querySelector(".reader-head .reader-actions");
    if (!actions || actions.dataset.dcCompact) return false;

    const refreshBtn = document.getElementById("refreshRankBtn");
    const openLink = document.getElementById("openPdfLink");
    const delBtn = document.getElementById("deletePaperBtn");
    const translateBtn = document.getElementById("translateClipboardBtn");
    if (!refreshBtn || !openLink || !delBtn) return false;

    actions.dataset.dcCompact = "1";

    // Move the translate button out of the (now-hidden) toolbar into the
    // reader actions row, right after 帮我阅读.
    if (translateBtn) {
      translateBtn.classList.add("dc-in-actions");
      actions.appendChild(translateBtn);
    }

    // Tuck the three secondary actions away (kept in DOM → handlers intact).
    refreshBtn.classList.add("dc-tucked");
    openLink.classList.add("dc-tucked");
    delBtn.classList.add("dc-tucked");

    // Build the ⋯ overflow button + menu.
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "dc-reader-more";
    moreBtn.id = "dcReaderMoreBtn";
    moreBtn.title = "更多操作";
    moreBtn.textContent = "⋯";
    actions.appendChild(moreBtn);

    const menu = document.createElement("div");
    menu.className = "dc-reader-menu";
    menu.id = "dcReaderMenu";
    menu.innerHTML = `
      <button type="button" data-proxy="refreshRankBtn">刷新期刊等级</button>
      <button type="button" data-proxy="openPdfLink">在新窗口打开 PDF</button>
      <button type="button" data-proxy="deletePaperBtn" class="danger">删除当前文献</button>
    `;
    document.body.appendChild(menu);

    // Menu item → proxy-click the original (hidden) button.
    menu.querySelectorAll("button[data-proxy]").forEach((item) => {
      item.addEventListener("click", () => {
        const target = document.getElementById(item.dataset.proxy);
        closeMenu();
        if (target && !target.classList.contains("dc-disabled-proxy")) {
          target.click();
        }
      });
    });

    function syncMenuDisabled() {
      // Reflect each underlying control's disabled state into the menu row.
      menu.querySelectorAll("button[data-proxy]").forEach((item) => {
        const target = document.getElementById(item.dataset.proxy);
        let disabled = false;
        if (target) {
          if (target.tagName === "A") {
            disabled = !target.getAttribute("href");
          } else {
            disabled = !!target.disabled;
          }
        }
        item.disabled = disabled;
      });
    }

    function openMenu() {
      syncMenuDisabled();
      const r = moreBtn.getBoundingClientRect();
      menu.style.top = (r.bottom + 4) + "px";
      // right-align the menu to the button
      menu.classList.add("open");
      const mw = menu.offsetWidth || 180;
      let left = r.right - mw;
      if (left < 8) left = 8;
      menu.style.left = left + "px";
      document.addEventListener("mousedown", onDocDown, true);
    }
    function closeMenu() {
      menu.classList.remove("open");
      document.removeEventListener("mousedown", onDocDown, true);
    }
    function onDocDown(e) {
      if (!menu.contains(e.target) && e.target !== moreBtn) closeMenu();
    }
    moreBtn.addEventListener("click", () => {
      if (menu.classList.contains("open")) closeMenu();
      else openMenu();
    });

    log("ready — reader header compacted");
    return true;
  }

  function boot() {
    if (!build()) requestAnimationFrame(boot);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
