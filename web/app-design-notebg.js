/* ============================================================================
 * 设计优化 · 笔记预览护眼背景色。
 *
 * 在笔记面板头部（预览/编辑 切换条 右侧）加一排小色点，点一下即可把
 * #notePreview + #noteEditor 的背景换成护眼色。选择记在 localStorage，
 * 切换文献/刷新都保持。
 *
 * 预设：纸白(默认) · 米黄 · 豆沙绿 · 雅灰 · 夜间。
 * 「纸白」清空内联样式 → 回落到主题变量，与深色主题兼容。
 * ========================================================================== */

(() => {
  const log = (...a) => console.log("[note-bg]", ...a);
  const KEY = "dc-note-bg";

  // bg 为空字符串 = 清除内联样式，回落到 CSS 变量（与全局深色主题联动）。
  const PRESETS = [
    { id: "paper", label: "纸白（默认）", bg: "",        text: "" },
    { id: "cream", label: "米黄护眼",     bg: "#f6efdc", text: "#3b3527" },
    { id: "green", label: "豆沙绿护眼",   bg: "#c7edcc", text: "#2b3a2e" },
    { id: "gray",  label: "雅灰护眼",     bg: "#e9e8e3", text: "#33312c" },
    { id: "dark",  label: "夜间护眼",     bg: "#23262b", text: "#cdc9bf" },
  ];

  const css = `
    .dc-notebg-row {
      display: inline-flex; align-items: center; gap: 5px;
      margin-right: auto;            /* 紧贴切换条，把保存状态推到右侧 */
      padding-left: 4px;
    }
    .dc-notebg-row::before {
      content: "护眼";
      font-size: 10.5px;
      color: var(--muted, #807a6f);
      margin-right: 2px;
    }
    .dc-notebg-dot {
      width: 15px; height: 15px; border-radius: 50%;
      border: 1px solid var(--line, #d9d6cf);
      padding: 0; cursor: pointer;
      box-sizing: border-box;
      transition: transform 0.1s;
    }
    .dc-notebg-dot:hover { transform: scale(1.18); }
    .dc-notebg-dot.active {
      box-shadow: 0 0 0 2px var(--panel, #fcfbf7),
                  0 0 0 3.5px var(--accent, #cc785c);
    }
    /* 夜间背景下，代码块/引用的浅色底改成半透明，避免刺眼色块 */
    #notePreview[data-notebg="dark"] code,
    #notePreview[data-notebg="dark"] pre {
      background: rgba(255,255,255,0.07);
      border-color: rgba(255,255,255,0.13);
      color: #cdc9bf;
    }
    #notePreview[data-notebg="dark"] blockquote {
      background: rgba(255,255,255,0.05);
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-notebg-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  function apply(id) {
    const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
    for (const elId of ["notePreview", "noteEditor"]) {
      const el = document.getElementById(elId);
      if (!el) continue;
      el.style.background = preset.bg;       // "" 清空 → 回落主题变量
      el.style.color = preset.text;
      el.dataset.notebg = preset.id;
    }
    try { localStorage.setItem(KEY, preset.id); } catch {}
    document.querySelectorAll(".dc-notebg-dot").forEach((dot) => {
      dot.classList.toggle("active", dot.dataset.bg === preset.id);
    });
  }

  function build() {
    const header = document.querySelector("#notePanel .note-header");
    if (!header || header.dataset.dcNotebg) return false;
    if (!document.getElementById("notePreview")) return false;
    header.dataset.dcNotebg = "1";

    const row = document.createElement("div");
    row.className = "dc-notebg-row";
    for (const preset of PRESETS) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "dc-notebg-dot";
      dot.dataset.bg = preset.id;
      dot.title = preset.label;
      dot.style.background = preset.bg || "var(--panel-strong, #fcfbf7)";
      dot.addEventListener("click", () => apply(preset.id));
      row.appendChild(dot);
    }

    // 插在「预览/编辑」切换条之后；切换条用 .seg 类。
    const seg = header.querySelector(".seg");
    if (seg && seg.nextSibling) header.insertBefore(row, seg.nextSibling);
    else header.appendChild(row);

    let saved = "paper";
    try { saved = localStorage.getItem(KEY) || "paper"; } catch {}
    apply(saved);

    log("ready — " + PRESETS.length + " presets, active=" + saved);
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
