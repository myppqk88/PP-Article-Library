/* ============================================================================
 * 多篇文献问答 (multi-paper Q&A over NOTES).
 *
 * Lets you pick several papers and ask the AI one question across them. The
 * backend reads each paper's NOTE file (not the PDF — fast, cheap), numbers
 * them [1][2]..., and the answer cites sources by number with a reference
 * list at the bottom.
 *
 * Two ways to build the 文献集 (per user's choice "both"):
 *   1. Left bulk-select → "多篇问 AI" button → papers pushed here via the
 *      `dc-multi-ask-papers` CustomEvent.
 *   2. The AI panel's own "+ 加文献" picker (searchable).
 *
 * Empty / placeholder notes are skipped server-side and reported.
 *
 * Backend: POST /api/ask-multi {paper_ids, question}
 * ========================================================================== */

(() => {
  const log = (...a) => console.log("[multiask]", ...a);

  const state = {
    papers: new Map(),   // paper_id -> {paper_id, title, authors, year}
    allPapers: [],       // cache for the picker
    busy: false,
  };

  // ---------------------------------------------------------- styles
  const css = `
    #dcMultiBar {
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 10px;
      background: var(--dc-panel-soft, #f5f1e8);
      padding: 8px 10px;
      margin: 6px 0;
      font-size: 12px;
    }
    #dcMultiBar .mb-head {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 6px;
    }
    #dcMultiBar .mb-title { font-weight: 600; color: var(--dc-text-strong, #1f1a14); }
    #dcMultiBar .mb-spacer { flex: 1; }
    #dcMultiBar button {
      font-size: 11px; padding: 3px 9px;
      border: 1px solid var(--dc-line, #d9d6cf); border-radius: 6px;
      background: var(--dc-bg-panel, #fff); color: var(--dc-text, #2b2620);
      cursor: pointer;
    }
    #dcMultiBar button:hover { border-color: var(--dc-accent, #c8553d); }
    #dcMultiBar #dcMultiAddBtn { background: var(--dc-accent, #c8553d); color: #fff; border-color: var(--dc-accent, #c8553d); }
    #dcMultiChips { display: flex; flex-wrap: wrap; gap: 5px; }
    #dcMultiChips:empty::after {
      content: "未选文献 — 点「+ 加文献」或在左栏多选后点「多篇问 AI」";
      color: var(--dc-muted, #6b6660); font-size: 11px;
    }
    .dc-multi-chip {
      display: inline-flex; align-items: center; gap: 5px;
      background: var(--dc-bg-panel, #fff);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 999px;
      padding: 2px 5px 2px 8px;
      font-size: 11px;
      max-width: 230px;
    }
    .dc-multi-chip .mc-n {
      background: var(--dc-accent, #c8553d); color: #fff;
      border-radius: 999px; padding: 0 5px; font-size: 9.5px; font-weight: 700;
    }
    .dc-multi-chip .mc-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dc-multi-chip .mc-x {
      cursor: pointer; color: var(--dc-muted, #6b6660);
      font-size: 13px; line-height: 1; padding: 0 2px;
    }
    .dc-multi-chip .mc-x:hover { color: var(--dc-danger, #c0392b); }
    #dcMultiBar.is-active { border-color: var(--dc-accent, #c8553d); }
    #dcMultiBar .mb-hint { font-size: 10.5px; color: var(--dc-accent-strong, #a23b28); margin-top: 5px; }

    /* paper picker popover */
    .dc-multi-pop {
      position: fixed; z-index: 1200;
      width: 380px; max-height: 420px;
      display: flex; flex-direction: column;
      background: var(--dc-bg-panel, #fff);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 10px;
      box-shadow: 0 12px 36px -8px rgba(20,14,8,0.32);
    }
    .dc-multi-pop input.mp-search {
      margin: 8px; padding: 6px 9px;
      border: 1px solid var(--dc-line, #d9d6cf); border-radius: 6px;
      background: var(--dc-bg-soft, #f5f1e8); color: var(--dc-text, #2b2620);
      font-size: 12px;
    }
    .dc-multi-pop .mp-list { overflow-y: auto; padding: 0 6px 8px; }
    .dc-multi-pop .mp-item {
      display: flex; gap: 7px; align-items: baseline;
      padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 12px;
    }
    .dc-multi-pop .mp-item:hover { background: var(--dc-bg-soft, #f5f1e8); }
    .dc-multi-pop .mp-item.picked { opacity: 0.5; }
    .dc-multi-pop .mp-check { width: 13px; flex-shrink: 0; }
    .dc-multi-pop .mp-meta { color: var(--dc-muted, #6b6660); font-size: 10.5px; }

    /* multi result area */
    #dcMultiResult {
      display: none;
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 4px 2px;
    }
    #dcMultiResult.is-on { display: block; }
    #dcMultiResult .mr-turn { margin-bottom: 14px; }
    #dcMultiResult .mr-q {
      background: var(--dc-accent-tint, #f3e0d8);
      border-radius: 10px 10px 10px 2px;
      padding: 8px 12px; font-size: 12.5px; margin-bottom: 8px;
      align-self: flex-start;
    }
    #dcMultiResult .mr-a {
      background: var(--dc-bg-panel, #fff);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 10px;
      padding: 10px 13px; font-size: 13px; line-height: 1.7;
      white-space: pre-wrap; word-break: break-word;
      -webkit-user-select: text; user-select: text;
    }
    #dcMultiResult .mr-refs {
      margin-top: 8px; font-size: 11.5px;
      border-top: 1px dashed var(--dc-line, #d9d6cf); padding-top: 7px;
    }
    #dcMultiResult .mr-refs .mr-ref {
      padding: 2px 0; cursor: pointer; color: var(--dc-text-soft, #6b6660);
    }
    #dcMultiResult .mr-refs .mr-ref:hover { color: var(--dc-accent-strong, #a23b28); }
    #dcMultiResult .mr-refs .mr-ref b { color: var(--dc-accent-strong, #a23b28); }
    #dcMultiResult .mr-skip {
      margin-top: 6px; font-size: 11px; color: var(--dc-danger, #c0392b);
    }
    #dcMultiResult .mr-loading { padding: 20px; text-align: center; color: var(--dc-muted, #6b6660); }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-multiask-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---------------------------------------------------------- DOM build
  function buildBar() {
    const panel = document.getElementById("aiPanel");
    const chatHistory = document.getElementById("chatHistory");
    if (!panel || !chatHistory || document.getElementById("dcMultiBar")) return;

    const bar = document.createElement("div");
    bar.id = "dcMultiBar";
    bar.innerHTML = `
      <div class="mb-head">
        <span class="mb-title">📚 多篇文献集</span>
        <span class="mb-spacer"></span>
        <button id="dcMultiAddBtn" type="button">+ 加文献</button>
        <button id="dcMultiClearBtn" type="button">清空</button>
      </div>
      <div id="dcMultiChips"></div>
      <div class="mb-hint" id="dcMultiHint" style="display:none"></div>
    `;
    // Insert the bar right above #chatHistory
    chatHistory.parentNode.insertBefore(bar, chatHistory);

    // Result area — our own, so phase2's chat machinery never touches it
    const result = document.createElement("div");
    result.id = "dcMultiResult";
    chatHistory.parentNode.insertBefore(result, chatHistory.nextSibling);

    document.getElementById("dcMultiAddBtn").addEventListener("click", openPicker);
    document.getElementById("dcMultiClearBtn").addEventListener("click", () => {
      state.papers.clear();
      renderChips();
    });
    renderChips();
  }

  function renderChips() {
    const host = document.getElementById("dcMultiChips");
    const bar = document.getElementById("dcMultiBar");
    const hint = document.getElementById("dcMultiHint");
    const result = document.getElementById("dcMultiResult");
    const chatHistory = document.getElementById("chatHistory");
    if (!host) return;
    host.innerHTML = "";
    let n = 0;
    for (const p of state.papers.values()) {
      n++;
      const chip = document.createElement("span");
      chip.className = "dc-multi-chip";
      chip.innerHTML = `
        <span class="mc-n">${n}</span>
        <span class="mc-t">${escapeHtml(p.title)}</span>
        <span class="mc-x" title="移除">×</span>`;
      chip.querySelector(".mc-x").addEventListener("click", () => {
        state.papers.delete(p.paper_id);
        renderChips();
      });
      host.appendChild(chip);
    }
    const active = state.papers.size > 0;
    if (bar) bar.classList.toggle("is-active", active);
    if (hint) {
      hint.style.display = active ? "" : "none";
      hint.textContent = active
        ? `下一个问题将基于这 ${state.papers.size} 篇文献的笔记作答（不读 PDF 原文）`
        : "";
    }
    // When the set is non-empty, show our result area + hide phase2's chat
    if (result) result.classList.toggle("is-on", active);
    if (chatHistory) chatHistory.style.display = active ? "none" : "";
  }

  // ---------------------------------------------------------- paper picker
  let pop = null;
  function closePicker() {
    if (pop) { pop.remove(); pop = null; }
    document.removeEventListener("mousedown", onDocDown, true);
  }
  function onDocDown(e) {
    if (pop && !pop.contains(e.target) &&
        e.target.id !== "dcMultiAddBtn") closePicker();
  }

  async function openPicker() {
    closePicker();
    const btn = document.getElementById("dcMultiAddBtn");
    pop = document.createElement("div");
    pop.className = "dc-multi-pop";
    pop.innerHTML = `
      <input class="mp-search" type="search" placeholder="搜索标题 / 作者…" />
      <div class="mp-list"><div style="padding:14px;text-align:center;color:var(--dc-muted)">加载中…</div></div>
    `;
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 392)) + "px";
    pop.style.top = (r.bottom + 4) + "px";
    pop.style.maxHeight = Math.min(420, window.innerHeight - r.bottom - 16) + "px";
    document.addEventListener("mousedown", onDocDown, true);

    // load papers
    if (!state.allPapers.length) {
      try {
        const resp = await fetch("/api/papers");
        const data = await resp.json();
        state.allPapers = (data.papers || []).map((p) => ({
          paper_id: p.paper_id,
          title: p.title_en || p.title || p["英文标题"] || p["中文标题"] || p.paper_id,
          authors: (p.authors || p["作者"] || "").split(/[;；,，]/)[0].trim(),
          year: p.year || p["年份"] || "",
        }));
      } catch (e) {
        if (pop) pop.querySelector(".mp-list").innerHTML =
          `<div style="padding:14px;color:#c0392b">加载失败：${escapeHtml(e.message)}</div>`;
        return;
      }
    }
    const search = pop.querySelector(".mp-search");
    const renderList = () => {
      const q = search.value.trim().toLowerCase();
      const list = pop.querySelector(".mp-list");
      const items = state.allPapers
        .filter((p) => !q || (p.title + " " + p.authors).toLowerCase().includes(q))
        .slice(0, 80);
      list.innerHTML = items.map((p) => `
        <div class="mp-item ${state.papers.has(p.paper_id) ? "picked" : ""}" data-id="${escapeAttr(p.paper_id)}">
          <span class="mp-check">${state.papers.has(p.paper_id) ? "✓" : "+"}</span>
          <span>
            <div>${escapeHtml(p.title)}</div>
            <div class="mp-meta">${escapeHtml([p.authors, p.year].filter(Boolean).join(" · "))}</div>
          </span>
        </div>`).join("") ||
        `<div style="padding:14px;text-align:center;color:var(--dc-muted)">无匹配</div>`;
      list.querySelectorAll(".mp-item").forEach((it) => {
        it.addEventListener("click", () => {
          const id = it.dataset.id;
          const p = state.allPapers.find((x) => x.paper_id === id);
          if (!p) return;
          if (state.papers.has(id)) state.papers.delete(id);
          else state.papers.set(id, p);
          renderChips();
          renderList();  // refresh check marks
        });
      });
    };
    search.addEventListener("input", renderList);
    search.addEventListener("mousedown", (e) => e.stopPropagation());
    renderList();
    search.focus();
  }

  // ---------------------------------------------------------- ask
  async function runMultiAsk() {
    if (state.busy) return;
    const input = document.getElementById("questionInput");
    const question = (input?.value || "").trim();
    if (!question) { alert("请先输入问题。"); return; }
    if (!state.papers.size) return;
    const ids = [...state.papers.keys()];
    state.busy = true;

    const result = document.getElementById("dcMultiResult");
    const turn = document.createElement("div");
    turn.className = "mr-turn";
    turn.innerHTML = `
      <div class="mr-q">${escapeHtml(question)}</div>
      <div class="mr-loading">正在阅读 ${ids.length} 篇文献的笔记并综合…</div>`;
    result.appendChild(turn);
    result.scrollTop = result.scrollHeight;
    if (input) input.value = "";

    try {
      const resp = await fetch("/api/ask-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paper_ids: ids, question }),
      });
      const data = await resp.json();
      if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
      renderAnswer(turn, data);
    } catch (e) {
      turn.querySelector(".mr-loading")?.remove();
      const err = document.createElement("div");
      err.className = "mr-a";
      err.style.cssText = "color:#8b2f24;background:#fcebe8;border-color:#e8c5be";
      err.textContent = "多篇问答失败：" + (e.message || e);
      turn.appendChild(err);
    } finally {
      state.busy = false;
    }
  }

  function renderAnswer(turn, data) {
    turn.querySelector(".mr-loading")?.remove();
    const a = document.createElement("div");
    a.className = "mr-a";
    a.textContent = data.answer || "(空回答)";
    turn.appendChild(a);

    if (data.references && data.references.length) {
      const refs = document.createElement("div");
      refs.className = "mr-refs";
      refs.innerHTML = "<div style='margin-bottom:3px;color:var(--dc-text-strong)'>参考文献</div>" +
        data.references.map((r) => {
          const meta = [r.authors ? String(r.authors).split(/[;；,，]/)[0].trim() : "", r.year]
            .filter(Boolean).join(", ");
          return `<div class="mr-ref" data-id="${escapeAttr(r.paper_id)}">` +
            `<b>[${r.n}]</b> ${escapeHtml(r.title)}${meta ? " · " + escapeHtml(meta) : ""}</div>`;
        }).join("");
      refs.querySelectorAll(".mr-ref").forEach((el) => {
        el.addEventListener("click", () => {
          // jump to that paper in the main list
          if (typeof window.selectPaper === "function") {
            window.selectPaper(el.dataset.id);
          } else {
            // fallback: click its list row
            const row = document.querySelector(`[data-paper-id="${el.dataset.id}"]`);
            if (row) row.click();
          }
        });
      });
      turn.appendChild(refs);
    }
    if (data.skipped && data.skipped.length) {
      const sk = document.createElement("div");
      sk.className = "mr-skip";
      sk.textContent = "⚠ 已跳过 " + data.skipped.length + " 篇无笔记的文献：" +
        data.skipped.map((s) => s.title).join("、");
      turn.appendChild(sk);
    }
    const result = document.getElementById("dcMultiResult");
    if (result) result.scrollTop = result.scrollHeight;
  }

  // ---------------------------------------------------------- send intercept
  // When the 文献集 is non-empty, the AI 发送 goes to multi-ask instead of the
  // normal single-paper /api/ask. Capture phase + stopImmediatePropagation so
  // phase2's #askBtn handler doesn't also fire.
  document.addEventListener("click", (e) => {
    if (!state.papers.size) return;
    const sendBtn = e.target.closest("#dcAiSendBtn, #askBtn");
    if (!sendBtn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    runMultiAsk();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!state.papers.size) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" &&
        e.target && e.target.id === "questionInput") {
      e.preventDefault();
      e.stopImmediatePropagation();
      runMultiAsk();
    }
  }, true);

  // ---------------------------------------------------------- bulk-bar bridge
  // Left-list bulk select dispatches this with the chosen paper ids.
  document.addEventListener("dc-multi-ask-papers", async (e) => {
    const ids = (e.detail && e.detail.paper_ids) || [];
    if (!ids.length) return;
    buildBar();
    // make sure we have paper metadata
    if (!state.allPapers.length) {
      try {
        const data = await (await fetch("/api/papers")).json();
        state.allPapers = (data.papers || []).map((p) => ({
          paper_id: p.paper_id,
          title: p.title_en || p.title || p["英文标题"] || p["中文标题"] || p.paper_id,
          authors: (p.authors || p["作者"] || "").split(/[;；,，]/)[0].trim(),
          year: p.year || p["年份"] || "",
        }));
      } catch {}
    }
    for (const id of ids) {
      const p = state.allPapers.find((x) => x.paper_id === id) ||
                { paper_id: id, title: id, authors: "", year: "" };
      state.papers.set(id, p);
    }
    renderChips();
    // switch to the AI inspector tab + focus the question box
    const aiTab = document.querySelector('#inspectorTabs .tab[data-tab="ai"]');
    if (aiTab) aiTab.click();
    const input = document.getElementById("questionInput");
    if (input) input.focus();
  });

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/["&<>]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function boot() {
    buildBar();
    if (!document.getElementById("dcMultiBar")) {
      // #aiPanel / #chatHistory not ready yet — retry
      requestAnimationFrame(boot);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  log("ready");
})();
