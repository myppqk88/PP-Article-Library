/* ============================================================
 * 文献工作台 — Design patch: 笔记 seg 状态机
 *
 * Phase 1 和 Phase 4 都给「预览 / 编辑 / 分屏」按钮装了事件，
 * 它们在 capture/bubble 阶段相互打架：
 *   - phase1 的 capture 阶段 stopImmediatePropagation → phase4 的 bubble
 *     处理永远跑不到 → 分屏按钮的 .active 永不清掉
 *   - phase1 的「编辑」按钮里调 previewBtn.click() 又会触发它自己的
 *     capture 拦截 → toggle 失败
 *
 * 修法：本 patch 抢在 capture 阶段最早接管所有 #notePanel .seg button
 * 点击，调用一个干净的状态机，然后 stopImmediatePropagation 把其它
 * patch 全部挡掉。
 * ============================================================ */

(function () {
  "use strict";

  // 单一状态：preview | edit | split
  let mode = "preview";

  function applyMode(next) {
    if (!["preview", "edit", "split"].includes(next)) next = "preview";
    mode = next;

    const notePanel = document.getElementById("notePanel");
    const noteEditor = document.getElementById("noteEditor");
    const notePreview = document.getElementById("notePreview");
    if (!notePanel || !noteEditor || !notePreview) return;

    // 1. seg button highlight — single active, others off
    document.querySelectorAll('#notePanel .seg button').forEach((b) => {
      const m = b.dataset.mode || (b.id === "previewBtn" ? "preview" : b.id === "editBtn" ? "edit" : "");
      b.classList.toggle("active", m === mode);
    });

    // 2. apply layout
    if (mode === "split") {
      notePanel.classList.add("note-split");
      let host = notePanel.querySelector(".note-split-host");
      if (!host) {
        host = document.createElement("div");
        host.className = "note-split-host";
        notePanel.appendChild(host);
      }
      if (noteEditor.parentElement !== host) host.appendChild(noteEditor);
      if (notePreview.parentElement !== host) host.appendChild(notePreview);
      noteEditor.classList.remove("hidden");
      notePreview.classList.remove("hidden");
      installLivePreview();
      livePreview();
    } else {
      // back to single-pane
      notePanel.classList.remove("note-split");
      const host = notePanel.querySelector(".note-split-host");
      if (host) {
        notePanel.insertBefore(noteEditor, host);
        notePanel.insertBefore(notePreview, host);
        host.remove();
      }
      if (mode === "edit") {
        noteEditor.classList.remove("hidden");
        notePreview.classList.add("hidden");
      } else { // preview
        noteEditor.classList.add("hidden");
        notePreview.classList.remove("hidden");
        // re-render preview from current textarea value
        renderPreviewFromTextarea();
      }
    }

    // 3. Keep app.js's internal `state.preview` consistent. We can't reach
    //    its private state directly, but we can read button text — app.js
    //    flips text "预览" ↔ "编辑" on each toggle. We override the text
    //    back to fixed labels so the buttons stay labeled correctly.
    const pb = document.getElementById("previewBtn");
    const eb = document.getElementById("editBtn");
    if (pb) pb.textContent = "预览";
    if (eb) eb.textContent = "编辑";

    // Persist preference
    try { localStorage.setItem("lit-hub-note-view", mode); } catch (_) {}
  }

  function renderPreviewFromTextarea() {
    const ed = document.getElementById("noteEditor");
    const pv = document.getElementById("notePreview");
    if (!ed || !pv) return;
    pv.innerHTML = simpleMarkdown(ed.value || "");
  }

  // Reuse the same mini-renderer as phase4
  function simpleMarkdown(src) {
    return String(src || "")
      .split(/\n\n+/)
      .map((block) => {
        block = block.trim();
        if (!block) return "";
        if (/^#{1,3}\s/.test(block)) {
          const m = block.match(/^(#{1,3})\s+(.+)/s);
          if (m) {
            const lv = m[1].length;
            return `<h${lv}>${escapeHtml(m[2])}</h${lv}>`;
          }
        }
        if (/^[-*]\s/.test(block)) {
          const items = block
            .split(/\n/)
            .filter((l) => /^[-*]\s/.test(l))
            .map((l) => `<li>${inline(l.replace(/^[-*]\s/, ""))}</li>`)
            .join("");
          return `<ul>${items}</ul>`;
        }
        return `<p>${inline(block).replace(/\n/g, "<br>")}</p>`;
      })
      .join("");
  }

  function inline(s) {
    s = escapeHtml(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return s;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  let livePreviewInstalled = false;
  function installLivePreview() {
    if (livePreviewInstalled) return;
    const ed = document.getElementById("noteEditor");
    if (!ed) return;
    ed.addEventListener("input", () => {
      if (mode === "split" || mode === "preview") livePreview();
    });
    livePreviewInstalled = true;
  }
  function livePreview() {
    const ed = document.getElementById("noteEditor");
    const pv = document.getElementById("notePreview");
    if (!ed || !pv) return;
    pv.innerHTML = simpleMarkdown(ed.value || "");
  }

  // ============================================================
  // Master capture-phase click interceptor.
  // ============================================================
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("#notePanel .seg button");
      if (!btn) return;
      // Block all other listeners — we are authoritative here.
      e.stopImmediatePropagation();
      e.preventDefault();
      const target =
        btn.dataset.mode ||
        (btn.id === "previewBtn" ? "preview" : btn.id === "editBtn" ? "edit" : "");
      if (!target) return;
      applyMode(target);
    },
    { capture: true }
  );

  // ============================================================
  // Boot: pick up saved mode + initial state
  // ============================================================
  function boot() {
    // Phase 4 might have already added 分屏 button. Make sure it has data-mode.
    const seg = document.querySelector("#notePanel .seg");
    if (seg) {
      seg.querySelectorAll("button").forEach((b) => {
        if (b.dataset.mode) return;
        if (b.id === "previewBtn") b.dataset.mode = "preview";
        else if (b.id === "editBtn") b.dataset.mode = "edit";
        else if (b.textContent.includes("分屏")) b.dataset.mode = "split";
      });
    }
    const saved = (() => {
      try { return localStorage.getItem("lit-hub-note-view"); } catch (_) { return null; }
    })();
    applyMode(saved || "preview");
  }

  // Wait until other patches have done their HTML injection
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 100));
  } else {
    setTimeout(boot, 100);
  }

  // Also: every time the paper changes, app.js may toggle classes — re-apply
  // our chosen mode shortly after.
  document.addEventListener("click", (e) => {
    if (e.target.closest(".paper-item, .paper-card")) {
      setTimeout(() => applyMode(mode), 200);
    }
  });
})();
