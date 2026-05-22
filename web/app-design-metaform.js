/* ============================================================================
 * 设计优化 · 第 3 批 —— 元信息表单瘦身。
 *
 * 之前：5 个 uppercase section head + 10+ 字段全摊开 + 1 颗橙色「保存分类」按钮。
 * 本补丁：
 *   1. 去掉 5 个 section head —— 字段标签 + 间距本身已经够清晰，小标题是噪音
 *   2. 中文标题 / 期刊分区 / 人工等级 / 领域标识  收进「更多」disclosure
 *      —— 这些字段 90% 时间用不到，默认折叠
 *   3. 去掉「保存分类」按钮 —— 每个字段都已绑定自动保存（已核实全覆盖），
 *      留一个绿点 +「已自动同步」状态即可
 *
 * 只移动 .meta-field 容器（输入框 id 和事件监听都在 input 上、随容器一起搬，
 * 不丢 wiring）。不改 saveMeta / autosaveMeta 逻辑。
 * ========================================================================== */

(() => {
  const log = (...a) => console.log("[metaform]", ...a);

  const css = `
    /* 1. section head 作为「分块」小标题 ------------------------------
       之前整段隐藏 section head → 面板成了一长串字段、看不出分块、很散。
       这里恢复成克制的小标题（小字、中性色、下边一条细线），每个
       .meta-section 就成了一个清晰的块。 */
    #metaPanel .meta-section-head {
      display: block !important;
      font-size: 11px;
      font-weight: 600;
      color: var(--muted, #807a6f);
      letter-spacing: 0.03em;
      margin: 0 0 8px;
      padding-bottom: 5px;
      border-bottom: 1px solid var(--line-soft, #ede9dd);
    }
    #metaPanel .meta-section { margin-bottom: 16px; }
    #metaPanel .meta-section:last-of-type { margin-bottom: 6px; }

    /* 3. 去保存按钮 —— 自动保存覆盖全部字段 -------------------------- */
    #metaPanel #saveMetaBtn { display: none !important; }
    #metaPanel .panel-actions {
      border-top: none !important;
      padding-top: 2px !important;
    }
    /* 自动保存状态：前面加一颗绿点 */
    #metaSaveStatus { font-size: 11px; }
    #metaSaveStatus:not(:empty)::before {
      content: "●";
      color: var(--dc-ok, #4f7d52);
      margin-right: 5px;
      font-size: 9px;
      vertical-align: 1px;
    }

    /* 2. 「更多」disclosure ------------------------------------------- */
    .dc-meta-more {
      border: 1px solid var(--dc-line, #e6e1d4);
      border-radius: var(--dc-r-card, 10px);
      background: var(--dc-panel-soft, #f5f3eb);
      margin: 8px 0 4px;
      padding: 0 10px;
    }
    .dc-meta-more > summary {
      cursor: pointer;
      list-style: none;
      padding: 8px 2px;
      font-size: 12px;
      color: var(--dc-muted, #807a6f);
      user-select: none;
      display: flex; align-items: center; gap: 6px;
    }
    .dc-meta-more > summary::-webkit-details-marker { display: none; }
    .dc-meta-more > summary::before {
      content: "▸";
      font-size: 10px;
      transition: transform 0.15s;
    }
    .dc-meta-more[open] > summary::before { transform: rotate(90deg); }
    .dc-meta-more[open] > summary {
      border-bottom: 1px solid var(--dc-line, #e6e1d4);
      margin-bottom: 8px;
    }
    .dc-meta-more-body { padding-bottom: 8px; }
    /* tucked fields stack vertically with small gaps */
    .dc-meta-more-body .meta-field { margin-bottom: 8px; }
    .dc-meta-more-body .meta-field:last-child { margin-bottom: 0; }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-metaform-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  function build() {
    const form = document.querySelector("#metaPanel .meta-panel-form");
    if (!form || form.dataset.dcMetaform) return false;
    const actions = form.querySelector(".panel-actions");
    if (!actions) return false;
    form.dataset.dcMetaform = "1";

    // Collect the .meta-field containers to tuck into the disclosure.
    const tuck = [];
    const pushField = (id) => {
      const el = document.getElementById(id);
      const field = el && el.closest(".meta-field");
      if (field && !tuck.includes(field)) tuck.push(field);
    };
    pushField("titleZh");          // 中文标题
    pushField("journalQuartile");  // 期刊分区
    pushField("journalRankManual");// 期刊等级（人工）
    pushField("journalRankAuto");  // EasyScholar 自动等级显示
    // 领域标识：原 .flag-grid 所在的 .meta-field（app-design-meta.js 把 chip 行
    // 也插在这个 .meta-field 内，一起搬走）
    const flagField = document.querySelector("#metaPanel .flag-grid");
    const flagMetaField = flagField && flagField.closest(".meta-field");
    if (flagMetaField && !tuck.includes(flagMetaField)) tuck.push(flagMetaField);

    if (!tuck.length) return true;  // nothing to tuck, but mark done

    const details = document.createElement("details");
    details.className = "dc-meta-more";
    const summary = document.createElement("summary");
    summary.textContent = "更多字段：中文标题 · 期刊分区 · 人工等级 · 领域标识";
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "dc-meta-more-body";
    details.appendChild(body);

    // Insert the disclosure right before the (now button-less) actions row,
    // then move every tucked field into it. Moving the .meta-field keeps each
    // input's id + event listeners intact.
    actions.parentNode.insertBefore(details, actions);
    for (const field of tuck) body.appendChild(field);

    log("ready — meta form slimmed (" + tuck.length + " fields tucked)");
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
